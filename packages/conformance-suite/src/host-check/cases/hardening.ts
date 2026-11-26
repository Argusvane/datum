import { hostCase, type CapabilityModule, type CaseContext } from "../case.js";
import { check, expectCode, expectNotContains, expectStatus } from "../expect.js";
import { checked, envelope, envelopeOf, HUGE, LOOP, MEMORY, STRAY, validValues, VERSION, delivered } from "../fixtures.js";
import type { Reply } from "../http.js";
import { has } from "../json.js";
import { CSRF_TOKEN, FIXTURE_FORM, REACHABLE, SUBMIT_ROUTE, VALIDATE_ROUTE } from "../preflight.js";

/**
 * HRD: the hardening subset over HTTP (the Java kit's HardeningContract, @Order 1801-1805). A packaged
 * host that registered the kit's hostile rule module (`datum-host-check fixtures` writes
 * hardening-rules.js) for the fixture form stops each attack inside the sandbox and answers the next
 * submission as before: a loop is cut at the validation budget, memory without bound and a 40 MiB
 * answer are refused, and bytes written after the answer frame (a forged outcome) refuse the run.
 * Each refuses that one submission, never an acceptance and never a 500. A run the sandbox stopped or
 * refused gave no verdict, so it answers 503 with the run's code (wasm.execution_error,
 * outcome_too_large) and no Retry-After, on a delivery and on a journey's check alike: a 422 would read
 * as a judgement of the answers. Only a verdict the kernel did reach (validator.failed, a rule module
 * that threw inside the guest) is a 422. Run it against a TEST deployment only: the module is hostile
 * on purpose, and the host should raise its validation memory (the Spring example uses 512 MB) so the
 * 40 MiB caps themselves are proven.
 */

/** A run the sandbox stopped answers within the budget (5 s by default) plus the stop grace; this is the bound. */
const STOPPED_WITHIN_MS = 20_000;

const HINT = "is the hostile rule module (hardening-rules.js) registered for the fixture form in this test deployment?";

function submit(context: CaseContext, name: string): Promise<Reply> {
  const values = validValues();
  values["name"] = name;
  return context.http.postJson(context.api("/submissions"), delivered(envelopeOf(VERSION, values)));
}

async function theNextRunAnswers(context: CaseContext): Promise<void> {
  const next = await context.http.postJson(context.api("/submissions"), delivered(envelope("CTL-01")));
  expectStatus(next, 200, "the run after an attack");
}

/** The codes of a run that gave no verdict: always a 503, never a 422. */
const RUN_FAILED = new Set(["wasm.execution_error", "outcome_too_large"]);

/**
 * Refused, with the status its code means: a failed run's code is a 503 without Retry-After (only
 * server.busy carries one); a verdict the kernel reached (validator.failed) is a 422. Never a 200,
 * never a 500. The body names a Datum code and never carries the guest's answer (under 64 KiB).
 */
function refused(reply: Reply, attack: string): void {
  const code = reply.isJson() ? reply.code() : "";
  if (RUN_FAILED.has(code)) {
    expectStatus(reply, 503, `${attack}: a run that failed is the server's 503 (${HINT})`);
    check(reply.header("retry-after") === undefined, () => `${attack}: only server.busy carries Retry-After, got ${reply.describe()}`);
  } else {
    expectStatus(reply, 422, `${attack}: a verdict the kernel reached is a 422 (${HINT})`);
  }
  check(reply.code() !== "", () => `${attack}: the refusal carries no error code in ${reply.describe()}`);
  check(reply.body.length < 64 * 1024, () => `${attack}: a refusal never carries the guest's answer, got ${reply.body.length} bytes`);
}

export const HARDENING: CapabilityModule = {
  capability: "hardening",
  probes: [REACHABLE, CSRF_TOKEN, SUBMIT_ROUTE, VALIDATE_ROUTE, FIXTURE_FORM],
  cases: [
    hostCase({
      id: "HRD-01",
      capability: "hardening",
      order: 1801,
      oracle: "HardeningContract#aLoopingValidatorIsStoppedWithinTheBudgetAndTheNextRunAnswers",
      expects: `POST <api>/submissions with name "${LOOP}" -> 503 wasm.execution_error, no Retry-After, within 20 s, no echo of the answer; the next CTL-01 submission -> 200`,
      async run(context) {
        const started = performance.now();
        const reply = await submit(context, LOOP);
        const took = performance.now() - started;
        refused(reply, "a looping validator");
        expectCode(reply, "wasm.execution_error", "a looping validator");
        expectStatus(reply, 503, "a looping validator");
        check(took < STOPPED_WITHIN_MS, () => `the loop was stopped after ${Math.round(took)} ms, not within ${STOPPED_WITHIN_MS} ms`);
        await theNextRunAnswers(context);
      }
    }),
    hostCase({
      id: "HRD-02",
      capability: "hardening",
      order: 1802,
      oracle: "HardeningContract#memoryWithoutBoundIsRefusedAndTheNextRunAnswers",
      expects: `POST <api>/submissions with name "${MEMORY}" -> an error code with the status it means (validator.failed 422; wasm.execution_error 503 without Retry-After); the next CTL-01 submission -> 200`,
      async run(context) {
        refused(await submit(context, MEMORY), "memory without bound");
        await theNextRunAnswers(context);
      }
    }),
    hostCase({
      id: "HRD-03",
      capability: "hardening",
      order: 1803,
      oracle: "HardeningContract#aFortyMebibyteAnswerIsCappedAndTheNextRunAnswers",
      expects: `POST <api>/submissions with name "${HUGE}" -> outcome_too_large or wasm.execution_error (503 without Retry-After) or validator.failed (422), under 64 KiB; the next CTL-01 submission -> 200`,
      async run(context) {
        const reply = await submit(context, HUGE);
        refused(reply, "a 40 MiB answer");
        expectCode(reply, ["outcome_too_large", "wasm.execution_error", "validator.failed"], "a 40 MiB answer");
        await theNextRunAnswers(context);
      }
    }),
    hostCase({
      id: "HRD-04",
      capability: "hardening",
      order: 1804,
      oracle: "HardeningContract#bytesWrittenAfterTheAnswerFrameRefuseTheRunAndForgeNothing",
      expects: `POST <api>/submissions with name "${STRAY}" -> 503 wasm.execution_error without Retry-After, the body never holds "forged"; the next CTL-01 submission -> 200`,
      async run(context) {
        const reply = await submit(context, STRAY);
        refused(reply, "bytes after the answer frame");
        expectCode(reply, "wasm.execution_error", "bytes after the answer frame");
        expectNotContains(reply.text(), "forged", "bytes after the answer frame");
        await theNextRunAnswers(context);
      }
    }),
    hostCase({
      id: "HRD-05",
      capability: "hardening",
      order: 1805,
      oracle: "HardeningContract#aLoopingValidatorIsA503OnAJourneyCheckNotAVerdict",
      expects: `POST <api>/submissions/validate {document (name "${LOOP}", journey main), scope: journey} -> 503 wasm.execution_error, no Retry-After, no "accepted" member, within 20 s (never a 200 {accepted: false}); the next CTL-01 submission -> 200`,
      async run(context) {
        const values = validValues();
        values["name"] = LOOP;
        const document = envelopeOf(VERSION, values);
        (document["submission"] as Record<string, unknown>)["journey"] = { id: "main" };
        const started = performance.now();
        const reply = await context.http.postJson(context.api("/submissions/validate"), checked(document, "journey"));
        const took = performance.now() - started;
        refused(reply, "a looping validator on a journey check");
        expectCode(reply, "wasm.execution_error", "a looping validator on a journey check");
        expectStatus(reply, 503, "a looping validator on a journey check");
        check(!has(reply.json(), "accepted"), () => `a failed run is no verdict, but the answer has an accepted member: ${reply.describe()}`);
        check(took < STOPPED_WITHIN_MS, () => `the loop was stopped after ${Math.round(took)} ms, not within ${STOPPED_WITHIN_MS} ms`);
        await theNextRunAnswers(context);
      }
    })
  ]
};
