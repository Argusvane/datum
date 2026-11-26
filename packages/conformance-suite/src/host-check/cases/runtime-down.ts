import { hostCase, type CapabilityModule } from "../case.js";
import { check, expectCode, expectStatus } from "../expect.js";
import { checked, envelope, delivered } from "../fixtures.js";
import { has } from "../json.js";
import { CSRF_TOKEN, REACHABLE, SUBMIT_ROUTE, VALIDATE_ROUTE } from "../preflight.js";

/**
 * RDN: a runtime that could not prove its program (fail-fast off, the program unreadable, or a
 * program below the host's ABI floor such as the kit's stale-program.js, refused with abi_mismatch):
 * the host still starts, and every submission is answered 503, never accepted unchecked (the Java
 * kit's RuntimeDownContract, @Order 1900-1901). The check is no verdict either: a runtime that is down answers it 503, never a 200 with a code in the errors. Run it against a TEST deployment started with the stale
 * program as its sandbox program; the fixture-form probe is left out on purpose, since a host with
 * its runtime down can only answer a check with 503.
 */
export const RUNTIME_DOWN: CapabilityModule = {
  capability: "runtime-down",
  probes: [REACHABLE, CSRF_TOKEN, SUBMIT_ROUTE, VALIDATE_ROUTE],
  cases: [
    hostCase({
      id: "RDN-01",
      capability: "runtime-down",
      order: 1900,
      oracle: "RuntimeDownContract#aRuntimeThatCannotProveItsProgramAnswers503ToEverySubmission",
      expects: "POST <api>/submissions {document: CTL-01} -> 503 with code server.unavailable or validator_unavailable",
      async run(context) {
        const reply = await context.http.postJson(context.api("/submissions"), delivered(envelope("CTL-01")));
        expectStatus(reply, 503);
        expectCode(reply, ["server.unavailable", "validator_unavailable"]);
      }
    }),
    hostCase({
      id: "RDN-02",
      capability: "runtime-down",
      order: 1901,
      oracle: "RuntimeDownContract#aRuntimeThatCannotProveItsProgramAnswers503ToAJourneyCheck",
      expects: "POST <api>/submissions/validate {document: CTL-01, scope: journey} -> 503 with code server.unavailable or validator_unavailable, and no accepted member",
      async run(context) {
        const reply = await context.http.postJson(context.api("/submissions/validate"), checked(envelope("CTL-01"), "journey"));
        expectStatus(reply, 503);
        expectCode(reply, ["server.unavailable", "validator_unavailable"]);
        check(!has(reply.json(), "accepted"), () => `a runtime that is down gives no verdict, but the answer has an accepted member: ${reply.describe()}`);
      }
    })
  ]
};
