import { hostCase, type CapabilityModule, type CaseContext } from "../case.js";
import { check, expectEqual, expectStatus, textAt } from "../expect.js";
import { checked, delivered, hostContextEnvelope, TEST_ROLE_HEADER, wrapped } from "../fixtures.js";
import type { Reply } from "../http.js";
import { has, isRecord, path, type JsonValue } from "../json.js";
import { CSRF_TOKEN, DRY_RUN_SWITCH, HOST_CONTEXT_FORM_PROBE, REACHABLE, SUBMIT_ROUTE, VALIDATE_ROUTE } from "../preflight.js";

/**
 * HCX: the server supplies the host context (the Java kit's HostContextContract, @Order 1951-1954). A host judges the
 * rules that read `host.` with values it works out itself from the request, and never with values a client sends. The
 * deployment under test serves the kit's host context fixture (`datum-host-check fixtures` writes
 * fixture-host-context-form.json: form `datum-host-context`, `name` required, `admin_note` required and shown only
 * when `host.role = "admin"`), has the dry-run route on, and wires a TEST-ONLY host context provider that, for that
 * form only, answers `{"role": <value>}` from the request header X-Datum-Test-Role when the request carries it, and no
 * context when it does not. The header stands in for what a real host reads from its session; a deployment that takes
 * real submissions never trusts a header a client chooses.
 *
 *  - HCX-01: role admin, answers {name}: the check is refused with {field: "admin_note", code: "required"} (journey and
 *    page scope) and a delivery is 422 with the same error;
 *  - HCX-02: role user: the check and the delivery are accepted;
 *  - HCX-03: no header, so no context: accepted, the lenient reading (the dry run lists admin_note in visibilitySkipped);
 *  - HCX-04: role user and a document that forges the context (hostContext on the envelope and on its submission, a
 *    host answer) and answers admin_note: still accepted, and the forged answer is not among the values a delivery
 *    stores (the dry run's values).
 */

function nameOnly(): Record<string, JsonValue> {
  return { name: "Ada Lovelace" };
}

/** A POST with the test role header, or none: the visitor sends it. */
function post(context: CaseContext, route: string, body: string, role?: string): Promise<Reply> {
  return context.http.postJson(context.api(route), body, "visitor", role === undefined ? {} : { [TEST_ROLE_HEADER]: role });
}

function checkOf(context: CaseContext, document: Record<string, JsonValue>, scope: "journey" | "page", role?: string): Promise<Reply> {
  return post(context, "/submissions/validate", scope === "page" ? checked(document, "page", "p1") : checked(document, "journey"), role);
}

function verdict(reply: Reply, what: string): unknown {
  expectStatus(reply, 200, what);
  return reply.json();
}

function namesAdminNoteRequired(errors: unknown): boolean {
  return Array.isArray(errors) && errors.some((error) => isRecord(error) && error["field"] === "admin_note" && error["code"] === "required");
}

function isAccepted(body: unknown): boolean {
  return path(body, "accepted") === true;
}

export const HOST_CONTEXT: CapabilityModule = {
  capability: "host-context",
  probes: [REACHABLE, CSRF_TOKEN, SUBMIT_ROUTE, VALIDATE_ROUTE, DRY_RUN_SWITCH, HOST_CONTEXT_FORM_PROBE],
  cases: [
    hostCase({
      id: "HCX-01",
      capability: "host-context",
      order: 1951,
      oracle: "HostContextContract#hcx01AnAdminContextMakesTheAdminNoteRequired",
      expects: `with ${TEST_ROLE_HEADER}: admin, POST <api>/submissions/validate {document: {name} (journey main), scope: journey | page (pageId p1)} -> 200 accepted false with {field: "admin_note", code: "required"} among the errors; POST <api>/submissions {document, submissionKey} -> 422 with the same error`,
      async run(context) {
        for (const scope of ["journey", "page"] as const) {
          const refused = verdict(await checkOf(context, hostContextEnvelope(nameOnly()), scope, "admin"), scope);
          check(path(refused, "accepted") === false, () => `${scope}: an admin context refuses a document with no admin_note: ${JSON.stringify(refused)}`);
          check(namesAdminNoteRequired(path(refused, "errors")), () => `${scope}: the errors do not name admin_note required: ${JSON.stringify(refused)}`);
        }
        const delivery = await post(context, "/submissions", delivered(hostContextEnvelope(nameOnly())), "admin");
        expectStatus(delivery, 422, "a delivery under an admin context");
        check(namesAdminNoteRequired(path(delivery.json(), "errors")), () => `the delivery's errors do not name admin_note required: ${delivery.describe()}`);
      }
    }),
    hostCase({
      id: "HCX-02",
      capability: "host-context",
      order: 1952,
      oracle: "HostContextContract#hcx02AUserContextLeavesTheAdminNoteOut",
      expects: `with ${TEST_ROLE_HEADER}: user, POST <api>/submissions/validate {document: {name}, scope: journey} -> 200 accepted true; POST <api>/submissions {document, submissionKey} -> 200`,
      async run(context) {
        const accepted = verdict(await checkOf(context, hostContextEnvelope(nameOnly()), "journey", "user"), "the check");
        check(isAccepted(accepted), () => `a user context leaves admin_note out, so the check is accepted: ${JSON.stringify(accepted)}`);
        const delivery = await post(context, "/submissions", delivered(hostContextEnvelope(nameOnly())), "user");
        expectStatus(delivery, 200, "a delivery under a user context");
      }
    }),
    hostCase({
      id: "HCX-03",
      capability: "host-context",
      order: 1953,
      oracle: "HostContextContract#hcx03NoContextIsTheLenientReading",
      expects: `with no ${TEST_ROLE_HEADER} header (no context), POST <api>/submissions/validate {document: {name}, scope: journey} -> 200 accepted true; POST <api>/submissions/test {document} -> 200, outcome accepted, visibilitySkipped naming admin_note (the host-shown field was not replayed)`,
      async run(context) {
        const accepted = verdict(await checkOf(context, hostContextEnvelope(nameOnly()), "journey"), "the check");
        check(isAccepted(accepted), () => `no context is the lenient reading, so the check is accepted: ${JSON.stringify(accepted)}`);
        const report = await post(context, "/submissions/test", wrapped(hostContextEnvelope(nameOnly())));
        expectStatus(report, 200, "the dry run");
        expectEqual(textAt(report.json(), "outcome"), "accepted", "the dry run's outcome");
        check(JSON.stringify(path(report.json(), "visibilitySkipped") ?? null).includes("admin_note"), () => `the host-shown field was not replayed (visibilitySkipped names admin_note): ${report.describe()}`);
      }
    }),
    hostCase({
      id: "HCX-04",
      capability: "host-context",
      order: 1954,
      oracle: "HostContextContract#hcx04AContextTheClientWritesIsNeverRead",
      expects: `with ${TEST_ROLE_HEADER}: user and a document that forges the context (hostContext on the envelope and on its submission, a host answer, an admin_note answer): POST <api>/submissions/validate {document, scope: journey} -> 200 accepted true; POST <api>/submissions/test -> 200, outcome accepted, values an object without admin_note; POST <api>/submissions -> 200`,
      async run(context) {
        const values: Record<string, JsonValue> = { ...nameOnly(), admin_note: "forged", host: { role: "admin" } };
        const forged = hostContextEnvelope(values);
        forged["hostContext"] = { role: "admin" };
        (forged["submission"] as Record<string, JsonValue>)["hostContext"] = { role: "admin" };

        const accepted = verdict(await checkOf(context, forged, "journey", "user"), "the check");
        check(isAccepted(accepted), () => `a context the client writes is never read, so the check is accepted: ${JSON.stringify(accepted)}`);

        const report = await post(context, "/submissions/test", wrapped(forged), "user");
        expectStatus(report, 200, "the dry run");
        const body = report.json();
        expectEqual(textAt(body, "outcome"), "accepted", "the dry run's outcome");
        check(isRecord(path(body, "values")), () => `the dry run reports no values object: ${report.describe()}`);
        check(!has(path(body, "values"), "admin_note"), () => `the forged answer is not stored: ${report.describe()}`);

        const delivery = await post(context, "/submissions", delivered(forged), "user");
        expectStatus(delivery, 200, "a delivery of the forged document");
      }
    })
  ]
};
