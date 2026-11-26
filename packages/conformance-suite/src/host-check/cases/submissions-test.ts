import { hostCase, type CapabilityModule } from "../case.js";
import { check, expectEqual, expectJsonEqual, expectMatches, expectSet, expectStatus, textAt } from "../expect.js";
import { envelope, golden, wrapped } from "../fixtures.js";
import { isRecord, path, shown } from "../json.js";
import { CSRF_TOKEN, DRY_RUN_SWITCH, FIXTURE_FORM, REACHABLE } from "../preflight.js";

/**
 * DRY: the dry-run route (`POST /submissions/test`, off unless the host switches it on; Spring Boot:
 * datum.web.api.endpoints.test=true). The report holds the values the kernel kept for the golden
 * valid document, exactly as the golden file has them (the Java kit's SubmissionsDryRunContract), and is one flat report of
 * exactly fourteen members, accepted or refused, the same on every host.
 */

/** The report's members, in the order the wire page lists them. No other member is allowed. */
export const DRY_RUN_MEMBERS = ["outcome", "stage", "errors", "sent", "values", "clientDerived", "clockDependent", "serverRules", "visibilitySkipped", "document", "digest", "logs", "sandbox", "signature"];

const DIGEST = /[0-9a-f]{64}/;

/**
 * The one shape of a dry-run report: exactly {@link DRY_RUN_MEMBERS} (no `accepted`, no nested `report`, no `notes`);
 * `errors` entries with all six keys (null where unknown, severity never null); the four lists string arrays; `logs` an
 * array; `sandbox` and `signature` null or an object.
 */
export function expectDryRunShape(report: unknown): void {
  check(isRecord(report), () => `the report is an object: ${shown(report)}`);
  expectSet([...Object.keys(report)].sort(), [...DRY_RUN_MEMBERS].sort(), "the report's members");
  check(["accepted", "rejected"].includes(textAt(report, "outcome")), () => `outcome is accepted or rejected: ${shown(report)}`);
  const stage = path(report, "stage");
  check(stage === null || ["journey", "sandbox", "signature", "server"].includes(textAt(report, "stage")), () => `stage is null or journey, sandbox, signature or server: ${shown(stage)}`);
  const errors = path(report, "errors");
  check(Array.isArray(errors), () => `errors is an array: ${shown(errors)}`);
  for (const error of errors as unknown[]) {
    check(isRecord(error), () => `an error is an object: ${shown(error)}`);
    expectSet(Object.keys(error).sort(), ["code", "field", "message", "severity", "source", "stage"], `the keys of ${shown(error)}`);
    check(typeof error["code"] === "string", () => `an error's code is text: ${shown(error)}`);
    check(typeof error["severity"] === "string", () => `severity defaults to error: ${shown(error)}`);
  }
  check(isRecord(path(report, "sent")), () => `sent is an object: ${shown(path(report, "sent"))}`);
  const values = path(report, "values");
  check(values === null || isRecord(values), () => `values is null or an object: ${shown(values)}`);
  for (const list of ["clientDerived", "clockDependent", "serverRules", "visibilitySkipped"]) {
    const ids = path(report, list);
    check(Array.isArray(ids) && ids.every((id) => typeof id === "string"), () => `${list} is an array of strings: ${shown(ids)}`);
  }
  const document = path(report, "document");
  check(document === null || typeof document === "string", () => `document is null or text: ${shown(document)}`);
  const digest = path(report, "digest");
  check(digest === null || typeof digest === "string", () => `digest is null or text: ${shown(digest)}`);
  if (typeof digest === "string") expectMatches(digest, DIGEST, "digest");
  check(Array.isArray(path(report, "logs")), () => `logs is an array: ${shown(path(report, "logs"))}`);
  const sandbox = path(report, "sandbox");
  check(sandbox === null || isRecord(sandbox), () => `sandbox is null or an object: ${shown(sandbox)}`);
  if (isRecord(sandbox)) expectSet(Object.keys(sandbox).sort(), ["elapsedMs", "logLevel", "rules", "unknownFields"], "the keys of sandbox");
  const signature = path(report, "signature");
  check(signature === null || isRecord(signature), () => `signature is null or an object: ${shown(signature)}`);
  if (isRecord(signature)) {
    check(typeof signature["status"] === "string" && Array.isArray(signature["errors"]), () => `signature is {status, errors}: ${shown(signature)}`);
  }
}

export const SUBMISSIONS_TEST: CapabilityModule = {
  capability: "submissions-test",
  probes: [REACHABLE, CSRF_TOKEN, DRY_RUN_SWITCH, FIXTURE_FORM],
  cases: [
    hostCase({
      id: "DRY-01",
      capability: "submissions-test",
      order: 1150,
      oracle: "SubmissionsDryRunContract#aDryRunReportsTheValuesTheKernelKeptForTheGoldenDocument",
      expects: "POST <api>/submissions/test {document: CTL-01} -> 200, outcome accepted, values equal to the golden file's CTL-01 values",
      async run(context) {
        const reply = await context.http.postJson(context.api("/submissions/test"), wrapped(envelope("CTL-01")));
        expectStatus(reply, 200);
        const report = reply.json();
        expectEqual(textAt(report, "outcome"), "accepted", "outcome");
        expectJsonEqual(path(report, "values"), path(golden(), "controls", "CTL-01", "values"), "values");
      }
    }),
    hostCase({
      id: "DRY-02",
      capability: "submissions-test",
      order: 1151,
      oracle: "SubmissionsDryRunContract#anAcceptedDryRunIsOneFlatReportOfFourteenMembers",
      expects: "POST <api>/submissions/test {document: CTL-01} -> 200, a report of exactly the 14 members, stage null, values and sandbox objects, document text, digest 64 hex",
      async run(context) {
        const reply = await context.http.postJson(context.api("/submissions/test"), wrapped(envelope("CTL-01")));
        expectStatus(reply, 200);
        const report = reply.json();
        expectDryRunShape(report);
        expectEqual(textAt(report, "outcome"), "accepted", "outcome");
        check(path(report, "stage") === null, () => `stage is null when accepted: ${shown(report)}`);
        check(isRecord(path(report, "values")), () => `values is an object: ${shown(report)}`);
        check(typeof path(report, "document") === "string", () => `a run happened, so there is a document: ${shown(report)}`);
        expectMatches(textAt(report, "digest"), DIGEST, "digest");
        check(isRecord(path(report, "sandbox")), () => `a run happened, so there is a sandbox: ${shown(report)}`);
      }
    }),
    hostCase({
      id: "DRY-03",
      capability: "submissions-test",
      order: 1152,
      oracle: "SubmissionsDryRunContract#aRefusedDryRunKeepsTheSameShapeAndNamesTheStage",
      expects: "POST <api>/submissions/test {document: CTL-02} -> 200, the same 14 members, outcome rejected, stage sandbox, findings with all six keys, digest 64 hex",
      async run(context) {
        const reply = await context.http.postJson(context.api("/submissions/test"), wrapped(envelope("CTL-02")));
        expectStatus(reply, 200);
        const report = reply.json();
        expectDryRunShape(report);
        expectEqual(textAt(report, "outcome"), "rejected", "outcome");
        expectEqual(textAt(report, "stage"), "sandbox", "stage");
        const errors = path(report, "errors");
        check(Array.isArray(errors) && errors.length > 0, () => `a refusal lists its findings: ${shown(report)}`);
        expectMatches(textAt(report, "digest"), DIGEST, "digest");
      }
    })
  ]
};
