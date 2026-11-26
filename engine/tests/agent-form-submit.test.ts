import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentActionDetail } from "../form-engine/agent/registrar.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import {
  AGENT_JOURNEY_FORM,
  AGENT_PARTICIPANTS_FORM,
  AGENT_SIGNING_BUTTON_FORM,
  AGENT_SINGLE_FORM,
  AGENT_STEPS_FORM,
  agentSetup,
  personTypes
} from "./fixtures/agent-form.js";

/**
 * submit: the signature recipe first and permanent,
 * the journey and submission-state refusals, a rejection worded for the agent, an acceptance with
 * the host's notice, the start / end `datum-agent-action` pair, the 30 s budget, and the spy that
 * proves `runtime.submit` is called with the provenance as its only option.
 */

type Row = Record<string, unknown>;

const FILLED = { name: "Ada", "grid[0].amount": 10 };

afterEach(() => {
  vi.useRealTimers();
});

describe("submit refusals", () => {
  it("signature-required for the button, the participants and the host's signWith, with the exact hint", async () => {
    const hint = "Fill the form and tell the person it is ready: they must press Submit themselves because the submission is signed.";
    const button = await agentSetup(AGENT_SIGNING_BUTTON_FORM).refused("submit");
    expect(button).toMatchObject({ code: "signature-required", retryable: false, message: "This form's submission is signed by the person, so an assistant cannot submit it.", hint, details: { because: "button" } });
    const participants = await agentSetup(AGENT_PARTICIPANTS_FORM).refused("submit");
    expect(participants).toMatchObject({ code: "signature-required", details: { because: "participants" } });
    const host = await agentSetup(AGENT_SINGLE_FORM, { host: { signWith: "webauthn" } }).refused("submit");
    expect(host).toMatchObject({ code: "signature-required", details: { because: "host" } });
    // The recipe comes first: a form that would also be refused for its answers still says signature-required.
    expect(button.code).toBe("signature-required");
  });

  it("not-at-end on a journey that is not on its final page, with the pages remaining", async () => {
    const setup = agentSetup(AGENT_JOURNEY_FORM);
    const result = await setup.refused("submit");
    expect(result).toMatchObject({ code: "not-at-end", hint: "Move through the remaining pages with navigate {to:'next'}, then submit.", details: { page: "intro", remaining: 2 } });
    expect(setup.runtime.state().submission.status).toBe("idle");
  });

  it("busy { submission } at once while a submission the agent did not start is in flight", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM, { hooks: { beforeSubmit: [() => new Promise<void>(() => undefined)] } });
    personTypes(setup.runtime, FILLED);
    // The person's (or the host's) submit, hanging in a hook: the agent's submit never waits on it.
    void setup.runtime.submit("embed", { form: { id: "single", version: "1.0.0" }, client: { runtimeVersion: "t", rendererVersion: "t", schemaVersion: "1.0.0" } }, {});
    const second = await setup.refused("submit");
    expect(second).toMatchObject({ code: "busy", retryable: true, details: { because: "submission" }, hint: "Wait a moment and call describe_form before retrying." });
    const begin = await setup.refused("begin_session", { purpose: "Later" });
    expect(begin).toMatchObject({ code: "busy", details: { because: "submission" } });
  });

  it("rejected when the form's checks refuse it: the errors worded, refusedBy validation, and shown to the person", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    const result = await setup.refused("submit");
    expect(result).toMatchObject({
      code: "rejected",
      retryable: false,
      hint: "Fix the listed problems with set_answers and submit again when check {scope:'form'} passes.",
      details: { refusedBy: "validation" }
    });
    expect(((result.details as Row).errors as Row[]).map((error) => [error.path, error.code, error.message])).toEqual([
      ["name", "required", "This field is required"],
      ["grid[0].amount", "required", "This field is required"]
    ]);
    expect(setup.runtime.errors().length).toBe(2);
    expect(setup.runtime.state().submission.status).toBe("rejected");
  });

  it("a beforeSubmit hook that throws is rejected as the host's refusal", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM, {
      hooks: {
        beforeSubmit: [
          () => {
            throw new Error("not today");
          }
        ]
      }
    });
    personTypes(setup.runtime, FILLED);
    const result = await setup.refused("submit");
    expect(result).toMatchObject({ code: "rejected", details: { refusedBy: "host", errors: [{ code: "hook", message: "not today", severity: "error", source: "custom" }] } });
    // The site's refusal is relayed to the person, never worked
    // around; the hint names the person and not set_answers.
    expect(result.hint).toBe(
      "The site refused the submission with the message in details.errors; tell the person what it says and let them act. Do not change answers to get past it unless the person asks."
    );
    expect(result.hint).not.toContain("set_answers");
    // The submission settles back to idle and the failure is the host's.
    expect(setup.runtime.state().submission.status).toBe("idle");
    const failed = setup.events.filter((event) => event.type === FormEventType.SUBMISSION_FAILED);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data).toMatchObject({ stage: "host" });
  });

  it("a transformValues that throws settles the same way, and the tool can submit again", async () => {
    // Both throw sources are covered: the transforms sit inside the same guard as the hook series,
    // so a throwing transform cannot leave the form 'submitting' (every tool would answer busy).
    let broken = true;
    const setup = agentSetup(AGENT_SINGLE_FORM, {
      hooks: {
        transformValues: [
          (values) => {
            if (broken) {
              throw new Error("transform broke");
            }
            return values;
          }
        ]
      }
    });
    personTypes(setup.runtime, FILLED);
    const result = await setup.refused("submit");
    expect(result).toMatchObject({ code: "rejected", details: { refusedBy: "host" } });
    expect(setup.runtime.state().submission.status).toBe("idle");
    const failed = setup.events.filter((event) => event.type === FormEventType.SUBMISSION_FAILED);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data).toMatchObject({ stage: "host" });

    broken = false;
    const again = await setup.ok("submit");
    expect(again.status).toBe("accepted");
    expect(setup.runtime.state().submission.status).toBe("submitted");
  });

  it("a rejection that is not a hook's keeps its hint (only a hook's is changed)", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    const result = await setup.refused("submit");
    expect(result).toMatchObject({ code: "rejected", details: { refusedBy: "validation" } });
    expect(result.hint).toBe("Fix the listed problems with set_answers and submit again when check {scope:'form'} passes.");
  });

  it("times out at 30 s with stillRunning while the host's submit is still out", async () => {
    vi.useFakeTimers();
    const setup = agentSetup(AGENT_SINGLE_FORM, { hooks: { beforeSubmit: [() => new Promise<void>(() => undefined)] } });
    personTypes(setup.runtime, FILLED);
    const call = setup.refused("submit");
    await vi.advanceTimersByTimeAsync(30_100);
    const result = await call;
    expect(result).toMatchObject({ code: "timeout", retryable: true, details: { afterMs: 30_000, stillRunning: true } });
  });

  it("stale when the answers moved since expectedRevision", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    personTypes(setup.runtime, FILLED);
    const seen = await setup.ok("get_answers");
    personTypes(setup.runtime, { name: "Changed" });
    const result = await setup.refused("submit", { expectedRevision: seen.revision });
    expect(result.code).toBe("stale");
    expect(setup.runtime.state().submission.status).toBe("idle");
  });
});

describe("submit accepted", () => {
  it("submits through the host with only the provenance as options, reports the id and notice, fires the start / end pair, clears the journal", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM, {
      host: { notice: () => ({ title: { default: "Claim received", locales: { fr: "Demande reçue" } }, message: "Thank you." }) }
    });
    const submit = vi.spyOn(setup.runtime, "submit");
    await setup.ok("set_answers", { answers: { name: "Ada", "grid[0].amount": 10 } });
    setup.host.calls.length = 0;
    const result = await setup.ok("submit");
    expect(result).toMatchObject({ status: "accepted", locale: "en", message: { title: "Claim received", text: "Thank you." } });
    expect(typeof result.submittedAt).toBe("number");
    expect(result.submissionId).toBe(setup.runtime.state().submission.lastSubmissionId);
    expect(result).not.toHaveProperty("values");
    expect(result).not.toHaveProperty("canonicalSubmission");
    expect(submit).toHaveBeenCalledTimes(1);
    const [modeId, version, options] = submit.mock.calls[0] as unknown as [string, Row, Row];
    expect(modeId).toBe("embed");
    expect(version).toMatchObject({ form: { id: "single", version: "1.0.0" } });
    // `{ agent }` and nothing else (never signWith, signing or trigger),
    // the snapshot taken before the runtime submitted: the agent's write is in it.
    expect(Object.keys(options)).toEqual(["agent"]);
    expect(options.agent).toMatchObject({ version: 1, involved: true, submittedBy: "agent", complete: true });
    expect((options.agent as Row).paths).toEqual(["grid[0].amount", "name"]);
    const emits = setup.host.calls.filter((call) => call.method === "emit" && call.args[0] === "datum-agent-action").map((call) => call.args[1] as Row);
    expect(emits.map((detail) => [detail.tool, (detail.outcome as Row).code ?? (detail.outcome as Row).ok])).toEqual([
      ["submit", "started"],
      ["submit", true]
    ]);
    expect(emits[0]).toMatchObject({ trigger: "agent", target: "form", readOnly: false, input: {}, durationMs: 0, changed: false, revision: expect.any(Number) });
    expect(setup.host.calls.find((call) => call.method === "announce")?.args).toEqual(["An assistant submitted the form"]);
    expect(setup.host.calls.find((call) => call.method === "submit")?.args).toEqual([{ agent: true }]);

    const undo = await setup.refused("undo_agent_changes");
    expect(undo).toMatchObject({ code: "submitted", hint: "The form was submitted; the submission cannot be undone from here." });
    expect(typeof (undo.details as Row).submittedAt).toBe("number");
    const again = await setup.refused("submit");
    expect(again).toMatchObject({ code: "already-submitted", hint: "Do not submit twice; tell the person it went through." });
    expect((again.details as Row).submissionId).toBe(result.submissionId);
    const described = await setup.ok("describe_form");
    expect(described.submit).toMatchObject({ available: false, how: "already-submitted" });
    expect((described.status as Row).submission).toBe("submitted");
    // A change after the submit lifts already-submitted.
    personTypes(setup.runtime, { name: "Ada Lovelace" });
    const third = await setup.ok("describe_form");
    expect(third.submit).toMatchObject({ available: true, how: "submit-tool" });
  });

  it("keeps the session open after an accepted submit so end_session can carry the summary", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    await setup.ok("begin_session", { purpose: "Submitting" });
    await setup.ok("set_answers", { answers: { name: "Ada", "grid[0].amount": 10 } });
    const result = await setup.ok("submit");
    expect(result.status).toBe("accepted");
    const ended = await setup.ok("end_session", { summary: "Sent." });
    expect(ended).toMatchObject({ wasOpen: true, session: { fieldsWritten: 0, undoable: 0 } });
    expect(setup.events.some((event) => event.type === FormEventType.SUBMISSION_COMPLETED)).toBe(true);
  });
});

describe("already-submitted holds until an answer changes", () => {
  it("survives a locale switch: describe_form still says already-submitted and a second submit is refused", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    const submit = vi.spyOn(setup.runtime, "submit");
    await setup.ok("set_answers", { answers: { name: "Ada", "grid[0].amount": 10 } });
    const first = await setup.ok("submit");
    expect(first.status).toBe("accepted");
    await setup.ok("set_locale", { locale: "fr" });
    const described = await setup.ok("describe_form");
    expect(described.submit).toMatchObject({ available: false, how: "already-submitted" });
    const again = await setup.refused("submit");
    expect(again).toMatchObject({ code: "already-submitted", details: { submissionId: first.submissionId } });
    expect(submit).toHaveBeenCalledTimes(1);
    // A check changes no answer either.
    await setup.ok("check", { scope: "form" });
    expect((await setup.refused("submit")).code).toBe("already-submitted");
    // An answer does.
    personTypes(setup.runtime, { name: "Ada Lovelace" });
    expect((await setup.ok("describe_form")).submit).toMatchObject({ available: true, how: "submit-tool" });
  });

  it("survives a move between steps after the submit", async () => {
    const setup = agentSetup(AGENT_STEPS_FORM);
    const submit = vi.spyOn(setup.runtime, "submit");
    await setup.ok("set_answers", { answers: { name: "Ada" } });
    await setup.ok("navigate", { to: "next" });
    expect((await setup.ok("submit")).status).toBe("accepted");
    await setup.ok("navigate", { to: "back" });
    expect((await setup.refused("submit")).code).toBe("already-submitted");
    expect((await setup.ok("describe_form")).submit).toMatchObject({ available: false, how: "already-submitted" });
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe("attribution during the agent's submit", () => {
  it("a value the person's form commits while the submission is out stays the person's", async () => {
    let live: ReturnType<typeof agentSetup>["runtime"] | undefined;
    const setup = agentSetup(AGENT_SINGLE_FORM, {
      hooks: {
        beforeSubmit: [
          async () => {
            if (live !== undefined) {
              personTypes(live, { colour: "red" });
            }
            throw new Error("stop");
          }
        ]
      }
    });
    live = setup.runtime;
    personTypes(setup.runtime, FILLED);
    const result = await setup.refused("submit");
    expect(result).toMatchObject({ code: "rejected", details: { refusedBy: "host" } });
    // An async throw settles the same way as a sync one.
    expect(setup.runtime.state().submission.status).toBe("idle");
    const failed = setup.events.filter((event) => event.type === FormEventType.SUBMISSION_FAILED);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data).toMatchObject({ stage: "host" });
    const answers = await setup.ok("get_answers");
    expect((answers.answers as Row[]).find((answer) => answer.path === "colour")).toMatchObject({ value: "red", lastWriter: "other" });
    const described = await setup.ok("describe_form");
    expect((described.fields as Row[]).find((field) => field.path === "colour")?.lastWriter).toBe("other");
  });
});

describe("submit's start event", () => {
  it("carries the handle, the revision and the session id, and reaches the registrar's subscribe() stream before the final event", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM, { host: { id: "claim" } });
    await setup.ok("set_answers", { answers: FILLED });
    await setup.ok("begin_session", { purpose: "Submitting" });
    const seen: AgentActionDetail[] = [];
    setup.registrar.subscribe((event) => {
      if (event.type === "action") {
        seen.push(event.detail);
      }
    });
    const revision = setup.registration.revision();
    await setup.ok("submit");
    expect(seen.map((detail) => [detail.tool, detail.outcome])).toEqual([
      ["submit", { ok: true, code: "started" }],
      ["submit", { ok: true }]
    ]);
    expect(seen[0]).toEqual({
      tool: "submit",
      target: "form",
      handle: "claim",
      readOnly: false,
      input: {},
      outcome: { ok: true, code: "started" },
      durationMs: 0,
      revision,
      changed: false,
      trigger: "agent",
      sessionId: "session-1"
    });
    const emitted = setup.host.calls.filter((call) => call.method === "emit" && call.args[0] === "datum-agent-action").map((call) => call.args[1] as Row);
    expect(emitted.find((detail) => (detail.outcome as Row).code === "started")).toEqual(seen[0]);
  });
});
