import { hostCase, type CapabilityModule } from "../case.js";
import { check, expectCode, expectHeader, expectStatus } from "../expect.js";
import { envelope, delivered } from "../fixtures.js";
import type { Reply } from "../http.js";
import { CSRF_TOKEN, FIXTURE_FORM, REACHABLE, SUBMIT_ROUTE } from "../preflight.js";

/**
 * FLD: the flood limits (the Java kit's FloodContract): asking too often is 429 flood with
 * Retry-After. FLD-01 posts the refused CTL-02 document (no record is made) until the host refuses,
 * at most 120 times, with no pause. FLD-02 posts a body that does not parse, at most 400 times, until
 * the host refuses: the address limit counts a request before its body is read, so a body that never
 * parses is counted too. Both spend the address's budget: the capability always runs last, and the
 * host sets a low per-form limit and an address limit above the rest of a kit run and below FLD-02's
 * 400 tries (Spring Boot: datum.web.throttle.limit=30 and datum.web.throttle.address-limit=200;
 * FastAPI: DATUM_WEB__THROTTLE__LIMIT=30 and DATUM_WEB__THROTTLE__ADDRESS_LIMIT=200).
 */
export const FLOOD: CapabilityModule = {
  capability: "flood",
  probes: [REACHABLE, CSRF_TOKEN, SUBMIT_ROUTE, FIXTURE_FORM],
  cases: [
    hostCase({
      id: "FLD-01",
      capability: "flood",
      order: 1073741823 + 9000, // Order.DEFAULT + 9000
      oracle: "FloodContract#askingTooOftenIs429WithRetryAfter",
      expects: "POST <api>/submissions {document: CTL-02} up to 120 times until 429 -> the last answer is 429 flood with a Retry-After header",
      async run(context) {
        const body = delivered(envelope("CTL-02"));
        let last: Reply | undefined;
        for (let i = 0; i < 120; i += 1) {
          last = await context.http.postJson(context.api("/submissions"), body);
          if (last.status === 429) break;
        }
        check(last !== undefined, "no request was sent");
        expectStatus(last, 429, "after 120 submissions");
        expectHeader(last, "Retry-After");
        expectCode(last, "flood");
      }
    }),
    hostCase({
      id: "FLD-02",
      capability: "flood",
      order: 1073741823 + 9001, // Order.DEFAULT + 9001
      oracle: "FloodContract#aBodyThatDoesNotParseIsCountedBeforeTheParse",
      expects: "POST <api>/submissions with Content-Type application/json and the body { (it does not parse) up to 400 times until 429 -> the last answer is 429 flood with a Retry-After header",
      async run(context) {
        let last: Reply | undefined;
        for (let i = 0; i < 400; i += 1) {
          last = await context.http.postJson(context.api("/submissions"), "{");
          if (last.status === 429) break;
        }
        check(last !== undefined, "no request was sent");
        expectStatus(last, 429, "after 400 bodies that do not parse (a host without the address limit answers 400 bad_document every time)");
        expectHeader(last, "Retry-After");
        expectCode(last, "flood");
      }
    })
  ]
};
