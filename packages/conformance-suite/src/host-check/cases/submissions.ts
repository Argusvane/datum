import { randomUUID } from "node:crypto";

import { hostCase, type CapabilityModule, type CaseContext } from "../case.js";
import { check, expectCode, expectEqual, expectMatches, expectSet, expectStatus, textAt } from "../expect.js";
import { checked, codes, controlValues, delivered, envelope, envelopeOf, golden, goldenErrors, VERSION, wrapped, type Control } from "../fixtures.js";
import { asBoolean, asString, has, isRecord, path } from "../json.js";
import { CSRF_TOKEN, FIXTURE_FORM, REACHABLE, SUBMIT_ROUTE, VALIDATE_ROUTE } from "../preflight.js";
import type { Reply } from "../http.js";

/**
 * SUB: story one, the receiving routes, over the kit's fixture form with the host's real kernel
 * (the Java kit's SubmissionsContract, @Order 1101-1107). The golden control documents (CTL-01
 * accepted, CTL-02 to CTL-04 refused with the kernel's errors), the journey check, the refusals that
 * come before the kernel is asked (409 stale version, 415, 413, 400, 404), and the submission key: a
 * retry of one attempt answered with the first receipt, another attempt with the same answers a
 * second record, a known key with another document 409 (before the document is judged, so an invalid
 * one is 409 too). A journey check has the one verdict shape (errors blocking only, notes for the
 * rest, no null field) and a strict request (400 for a bare document, a missing scope, a page beside
 * a journey scope, a page check with no page). The host serves the fixture form at version 1 and
 * allows at least 20 submissions a minute from one address.
 */
const submit = (context: CaseContext, body: string): Promise<Reply> => context.http.postJson(context.api("/submissions"), body);

/** `field` is left out when a finding names none, never `null`. */
function checkFieldIsLeftOut(entry: Record<string, unknown>): void {
  check(!(has(entry, "field") && entry["field"] === null), () => `field is left out, not null: ${JSON.stringify(entry)}`);
}

function checkKeys(entry: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const extra = Object.keys(entry).filter((key) => !allowed.includes(key));
  check(extra.length === 0, () => `${what} holds ${extra.map((key) => JSON.stringify(key)).join(", ")} beside ${allowed.join(", ")}: ${JSON.stringify(entry)}`);
}

/**
 * The verdict's one wire shape, on every host: `errors` holds only what blocks, each entry `{field?, code, message?}`
 * (no severity, and no `field` member when the finding names none, never null); `notes` (warnings and info, each with
 * its severity) is left out or a non-empty list. Nothing in either list is null-valued.
 */
function checkVerdictShape(verdict: unknown): void {
  check(isRecord(verdict), () => `the verdict is not an object: ${JSON.stringify(verdict)}`);
  checkKeys(verdict as Record<string, unknown>, ["accepted", "errors", "notes"], "the verdict");
  const errors = (verdict as Record<string, unknown>)["errors"];
  check(Array.isArray(errors), () => `the verdict's errors is not an array: ${JSON.stringify(verdict)}`);
  for (const error of errors as unknown[]) {
    check(isRecord(error), () => `an errors entry that is not an object: ${JSON.stringify(error)}`);
    checkKeys(error as Record<string, unknown>, ["field", "code", "message"], "an errors entry");
    check(typeof (error as Record<string, unknown>)["code"] === "string", () => `an errors entry with no code: ${JSON.stringify(error)}`);
    checkFieldIsLeftOut(error as Record<string, unknown>);
  }
  if (has(verdict, "notes")) {
    const notes = (verdict as Record<string, unknown>)["notes"];
    check(Array.isArray(notes), () => `notes is not an array: ${JSON.stringify(verdict)}`);
    check((notes as unknown[]).length > 0, () => `notes is left out when empty: ${JSON.stringify(verdict)}`);
    for (const note of notes as unknown[]) {
      check(isRecord(note), () => `a notes entry that is not an object: ${JSON.stringify(note)}`);
      checkKeys(note as Record<string, unknown>, ["field", "code", "severity", "message"], "a notes entry");
      const severity = asString((note as Record<string, unknown>)["severity"]);
      check(severity === "warning" || severity === "info", () => `a note's severity is warning or info, got ${JSON.stringify(severity)}: ${JSON.stringify(note)}`);
      checkFieldIsLeftOut(note as Record<string, unknown>);
    }
  }
  if (asBoolean(path(verdict, "accepted"))) {
    check((errors as unknown[]).length === 0, () => `an accepted verdict has no blocking error: ${JSON.stringify(verdict)}`);
  }
}

export const SUBMISSIONS: CapabilityModule = {
  capability: "submissions",
  probes: [REACHABLE, CSRF_TOKEN, SUBMIT_ROUTE, VALIDATE_ROUTE, FIXTURE_FORM],
  cases: [
    hostCase({
      id: "SUB-01",
      capability: "submissions",
      order: 1101,
      oracle: "SubmissionsContract#theGoldenValidDocumentIsAcceptedWithADigestAndAReceipt",
      expects: "POST <api>/submissions {document: CTL-01, submissionKey} -> 200 JSON, status accepted, a 64-hex digest and an id; the bare CTL-01 document, or {document} with no key -> 400 bad_document",
      async run(context) {
        const reply = await submit(context, delivered(envelope("CTL-01")));
        expectStatus(reply, 200);
        check(reply.mediaType().endsWith("json"), () => `the media type ${JSON.stringify(reply.mediaType())} does not end with json`);
        const body = reply.json();
        expectEqual(textAt(body, "status"), "accepted", "status");
        const digest = textAt(body, "digest");
        expectEqual(digest.length, 64, "the digest's length");
        expectMatches(digest, /[0-9a-f]{64}/, "digest");
        check(textAt(body, "id").trim() !== "", "the receipt's id is blank");
        // A delivery carries its submit attempt's key; without one it is never received.
        const bare = await submit(context, JSON.stringify(envelope("CTL-01")));
        expectStatus(bare, 400, "the bare document");
        expectCode(bare, "bad_document", "the bare document");
        const keyless = await submit(context, JSON.stringify({ document: envelope("CTL-01") }));
        expectStatus(keyless, 400, "a delivery without a key");
        expectCode(keyless, "bad_document", "a delivery without a key");
      }
    }),
    hostCase({
      id: "SUB-02",
      capability: "submissions",
      order: 1102,
      oracle: "SubmissionsContract#theGoldenInvalidDocumentsAreRefusedWithTheKernelsErrors",
      expects: "POST <api>/submissions {document: CTL-02 | CTL-03 | CTL-04} -> 422 each, with exactly the golden code@field set (required@name, maxLength@name, pattern@code)",
      async run(context) {
        for (const control of ["CTL-02", "CTL-03", "CTL-04"] as const) {
          const reply = await submit(context, delivered(envelope(control)));
          expectStatus(reply, 422, control);
          expectSet(codes(path(reply.json(), "errors")), goldenErrors(control), control);
        }
      }
    }),
    hostCase({
      id: "SUB-03",
      capability: "submissions",
      order: 1103,
      oracle: "SubmissionsContract#aJourneyCheckAnswersTheSuitesVerdict",
      expects: "POST <api>/submissions/validate {document (journey main), scope: journey} for CTL-01 and CTL-02 -> 200, accepted as the golden file says; CTL-02's errors hold required@name; the verdict is {accepted, errors, notes?} only: errors blocking, entries {field?, code, message?} with no severity and no null field, notes (when any) {field?, code, severity, message?}",
      async run(context) {
        for (const control of ["CTL-01", "CTL-02"] as const satisfies readonly Control[]) {
          const document = envelope(control);
          (document["submission"] as Record<string, unknown>)["journey"] = { id: "main" };
          const reply = await context.http.postJson(context.api("/submissions/validate"), JSON.stringify({ document, scope: "journey" }));
          expectStatus(reply, 200, control);
          const verdict = reply.json();
          expectEqual(asBoolean(path(verdict, "accepted")), asBoolean(path(golden(), "controls", control, "accepted")), `${control} accepted`);
          if (control === "CTL-02") {
            const found = codes(path(verdict, "errors"));
            check(found.includes("required@name"), () => `${control}: errors [${found.join(", ")}] do not contain required@name`);
          }
          checkVerdictShape(verdict);
        }
      }
    }),
    hostCase({
      id: "SUB-04",
      capability: "submissions",
      order: 1104,
      oracle: "SubmissionsContract#aStaleVersionTheWrongTypeAndAHugeBodyAreRefusedBeforeTheKernelIsAsked",
      expects: "version 0 -> 409 form.outdated; Content-Type text/plain -> 415 unsupported_media_type; a body of 1 MiB + 16 bytes of padding -> 413 bad_document",
      async run(context) {
        const stale = await submit(context, delivered(envelopeOf("0", controlValues("CTL-01"))));
        expectStatus(stale, 409, "a stale version");
        expectCode(stale, "form.outdated", "a stale version");

        const wrongType = await context.http.post(context.api("/submissions"), "text/plain", "{}");
        expectStatus(wrongType, 415, "text/plain");
        expectCode(wrongType, "unsupported_media_type", "text/plain");

        const huge = await submit(context, `{"document":{"pad":"${"x".repeat(1024 * 1024 + 16)}"}}`);
        expectStatus(huge, 413, "a huge body");
        expectCode(huge, "bad_document", "a huge body");
      }
    }),
    hostCase({
      id: "SUB-05",
      capability: "submissions",
      order: 1105,
      oracle: "SubmissionsContract#notJsonIs400AndAnUnknownFormIs404",
      expects: 'a body cut off after {"document": -> 400 bad_document; CTL-01 naming the form datum-tck-no-such-form -> 404 form.notFound',
      async run(context) {
        const notJson = await submit(context, '{"document":');
        expectStatus(notJson, 400, "not JSON");
        expectCode(notJson, "bad_document", "not JSON");

        const unknown = envelope("CTL-01");
        ((unknown["versionContext"] as Record<string, unknown>)["form"] as Record<string, unknown>)["id"] = "datum-tck-no-such-form";
        const missing = await submit(context, delivered(unknown));
        expectStatus(missing, 404, "an unknown form");
        expectCode(missing, "form.notFound", "an unknown form");
      }
    }),
    hostCase({
      id: "SUB-06",
      capability: "submissions",
      order: 1106,
      oracle: "SubmissionsContract#aSubmitAttemptIsOneRecordByItsKey",
      expects:
        "one document no other case sends, posted twice with one key -> 200 both, handled false then true, the second answer repeats the first receipt's id, reference and digest; the same answers under another key -> 200 handled false with another id; the first key with another document -> 409 submission.keyConflict; the first key with another document that fails a rule -> 409 submission.keyConflict too, never 422 (a known key is answered before the document is judged)",
      async run(context) {
        // A document no other case sends: the name differs from every golden control and from earlier runs
        // (Long.toString(System.nanoTime() % 100000, 36), as the Java kit makes it).
        const values = controlValues("CTL-01");
        values["name"] = `Grace Hopper ${Number(process.hrtime.bigint() % 100000n).toString(36)}`;
        const attempt = randomUUID();
        const body = delivered(envelopeOf(VERSION, values), attempt);
        const first = await submit(context, body);
        expectStatus(first, 200, "the first delivery");
        const again = await submit(context, body);
        expectStatus(again, 200, "the second delivery");
        const firstBody = first.json();
        const againBody = again.json();
        expectEqual(asBoolean(path(firstBody, "handled"), true), false, "the first answer's handled");
        expectEqual(asBoolean(path(againBody, "handled"), false), true, "the second answer's handled");
        // The first receipt again: the handler did not run.
        expectEqual(textAt(againBody, "id"), textAt(firstBody, "id"), "id");
        expectEqual(textAt(againBody, "reference"), textAt(firstBody, "reference"), "reference");
        expectEqual(textAt(againBody, "digest"), textAt(firstBody, "digest"), "digest");

        // Another person with the same answers: another attempt, another record.
        const other = await submit(context, delivered(envelopeOf(VERSION, values)));
        expectStatus(other, 200, "the same answers under another key");
        expectEqual(asBoolean(path(other.json(), "handled"), true), false, "the other attempt's handled");
        check(textAt(other.json(), "id") !== textAt(firstBody, "id"), "the other attempt was answered with the first record");

        // The first key with another document: refused, never answered with the first receipt.
        const changed = { ...values, name: `${String(values["name"])} again` };
        const conflict = await submit(context, delivered(envelopeOf(VERSION, changed), attempt));
        expectStatus(conflict, 409, "a known key with another document");
        expectCode(conflict, "submission.keyConflict", "a known key with another document");

        // The first key with a document the form refuses: still the conflict, not the errors. A known
        // key is answered before the document is judged, so every host gives the same answer here.
        const refused = await submit(context, delivered(envelopeOf(VERSION, { ...values, code: "abc" }), attempt));
        expectStatus(refused, 409, "a known key with another document that fails a rule");
        expectCode(refused, "submission.keyConflict", "a known key with another document that fails a rule");
      }
    }),
    hostCase({
      id: "SUB-07",
      capability: "submissions",
      order: 1107,
      oracle: "SubmissionsContract#aCheckIsStrictAboutItsRequest",
      expects:
        "POST <api>/submissions/validate with the bare CTL-01 document (journey main) -> 400 bad_document; {document} with no scope -> 400; scope all -> 400; scope journey with a pageId -> 400 and no accepted member; scope page with no pageId -> 400. The body is the {document, scope, pageId?} wrapper, answered before the kernel is asked",
      async run(context) {
        const document = envelope("CTL-01");
        (document["submission"] as Record<string, unknown>)["journey"] = { id: "main" };
        const url = context.api("/submissions/validate");

        const bare = await context.http.postJson(url, JSON.stringify(document));
        expectStatus(bare, 400, "a bare document");
        expectCode(bare, "bad_document", "a bare document");

        const noScope = await context.http.postJson(url, wrapped(document));
        expectStatus(noScope, 400, "no scope");

        const unknownScope = await context.http.postJson(url, JSON.stringify({ document, scope: "all" }));
        expectStatus(unknownScope, 400, "another scope");

        const pageBesideJourney = await context.http.postJson(url, JSON.stringify({ document, scope: "journey", pageId: "p1" }));
        expectStatus(pageBesideJourney, 400, "pageId with scope journey");
        check(!has(pageBesideJourney.json(), "accepted"), () => `a refused request is no verdict: ${pageBesideJourney.describe()}`);

        const pageWithoutId = await context.http.postJson(url, checked(document, "page"));
        expectStatus(pageWithoutId, 400, "scope page with no pageId");
      }
    })
  ]
};
