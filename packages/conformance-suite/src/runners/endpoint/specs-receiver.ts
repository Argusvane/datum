import { randomUUID } from "node:crypto";

import { validValues } from "../../fixtures/base-form.js";
import { CONTROL_VALUES, POLLUTION_MARKER, TOSTRING_MARKER } from "../../fixtures/controls.js";
import type { Json } from "../../observation.js";
import type { Expectation } from "../../predicates.js";
import { nested } from "./applicability.js";
import { UNKNOWN_FORM_ID } from "./http.js";
import type { EndpointRow, EndpointSpec, RequestSpec, RowContext } from "./rows.js";

/**
 * REC: the receiver and HTTP contract. Each row is one request (or a short series) and the
 * status/code the `@argusvane/datum-submissions` HTTP mapping answers ("never a 5xx" holds for every row).
 */
const accepted = (value: boolean): Expectation => ({ op: "accepted", value });
const all = (...of: Expectation[]): Expectation => ({ op: "all", of });
const any = (...of: Expectation[]): Expectation => ({ op: "any", of });
const refusal = (...anyOf: Extract<Expectation, { op: "refusal" }>["anyOf"]): Expectation => ({ op: "refusal", anyOf });
const badDocument: Expectation = { op: "refusal", anyOf: ["bad_document"], codes: ["bad_document"] };
const noFailure: Expectation = { op: "custom", name: "no-server-failure" };
const judgedOrRefused: Expectation = any(accepted(true), accepted(false), refusal("bad_document"));
const without = (...markers: string[]): Expectation => ({ op: "textExcludes", markers });

const check = (parts: Omit<Extract<RequestSpec, { kind: "check" }>, "kind"> = {}): RequestSpec => ({ kind: "check", ...parts });
const submit = (parts: Omit<Extract<RequestSpec, { kind: "submit" }>, "kind"> = {}): RequestSpec => ({ kind: "submit", ...parts });
const raw = (route: "validate" | "submit", body: Extract<RequestSpec, { kind: "raw" }>["body"] | undefined, rest: Partial<Extract<RequestSpec, { kind: "raw" }>> = {}): RequestSpec => ({
  kind: "raw",
  route,
  ...(body !== undefined ? { body } : {}),
  ...rest
});
const row = (id: string, requests: RequestSpec[], expect: Expectation, rest: Partial<EndpointRow> = {}): EndpointRow => ({ id, requests, expect, ...rest });
const valid = (): Record<string, Json> => validValues() as Record<string, Json>;

function withValues(more: Record<string, Json>): Json {
  return { ...valid(), ...more };
}

/** One run's submission keys: fresh per run, so a host that remembers keys across runs never meets one twice. */
const RUN_KEY = randomUUID();

const SIGNING_FORMAT = { scope: "envelope", placement: "wrapper", digest: "sha-256", canonicalization: "jcs" };

/** A check body whose `values.n` is the literal JSON text `1e999` (JSON.stringify cannot write it). */
const infinite = (literal: string) => (context: RowContext): string =>
  context.checkBody({ values: withValues({ rows: [{ sku: "s1", n: "ZZNUMZZ" }] }) }).replace('"ZZNUMZZ"', literal);

// Shaped as a delivery ({"document": {...}}) so a service with no host in front of it meets the size before the shape: its own cap (maxBodyBytes, 413 payload_too_large) answers.
const bodyOver = (extra: number) => (context: RowContext): string => {
  const head = `{"document":{"pad":"`;
  const tail = `"}}`;
  return `${head}${"x".repeat(Math.max(0, context.bodyLimit + extra - head.length - tail.length))}${tail}`;
};

export const RECEIVER_ENDPOINT_SPECS: Record<string, EndpointSpec> = {
  "REC-01": {
    rows: [
      ["empty", ""],
      ["open-brace", "{"],
      ["not-json", "nope"],
      ["null", "null"],
      ["array", "[]"],
      ["string", '"x"'],
      ["number", "1"],
      ["invalid-utf8", new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d])]
    ].map(([id, body]) => row(id as string, [raw("validate", body as string | Uint8Array)], badDocument))
  },
  "REC-02": {
    rows: [
      row("positive", [raw("validate", infinite("1e999"))], badDocument, { profileExpect: { submissions: any(badDocument, accepted(false)) } }),
      row("negative", [raw("validate", infinite("-1e999"))], badDocument, { profileExpect: { submissions: any(badDocument, accepted(false)) } })
    ]
  },
  "REC-03": {
    rows: [
      row("over-the-limit", [raw("validate", bodyOver(1))], { op: "refusal", anyOf: ["too_large"], codes: ["bad_document"] }, { profileExpect: { submissions: { op: "custom", name: "body-limit" } } }),
      // 64 KiB over: past the service's own cap (maxBodyBytes, measured on the document inside the wrapper) as well, so a service with no host in front answers 413 payload_too_large.
      row("well-over-the-limit", [raw("validate", bodyOver(65_536))], { op: "refusal", anyOf: ["too_large"], codes: ["bad_document"] }, { profileExpect: { submissions: { op: "refusal", anyOf: ["too_large"], codes: ["bad_document", "payload_too_large"] } } })
    ]
  },
  "REC-04": {
    rows: [
      row("70-levels", [check({ values: withValues({ deep: nested(70) }) })], badDocument, { profileExpect: { submissions: noFailure } }),
      row("65-levels", [check({ values: withValues({ deep: nested(65) }) })], badDocument, { profileExpect: { submissions: noFailure } })
    ]
  },
  "REC-05": {
    rows: [
      row("wrong-form-id", [check({ formId: UNKNOWN_FORM_ID })], badDocument, { profileExpect: { submissions: any(badDocument, refusal("not_found")) } }),
      row("no-values", [check({ omitValues: true })], badDocument),
      row("bad-scope", [check({ scope: "everything" })], badDocument),
      row("unknown-page", [check({ scope: "page", pageId: "no-such-page" })], badDocument),
      row("page-without-pageid", [check({ scope: "page" })], badDocument),
      row("scope-on-submit", [submit({ extra: { scope: "journey" } })], badDocument),
      row("pageid-on-submit", [submit({ extra: { pageId: "p1" } })], badDocument)
    ]
  },
  "REC-06": {
    rows: [
      row("other-version", [check({ formVersion: "0" })], refusal("outdated"), { profileExpect: { submissions: any(refusal("outdated"), refusal("not_found")) } }),
      row("future-version", [check({ formVersion: "999" })], refusal("outdated"), { profileExpect: { submissions: any(refusal("outdated"), refusal("not_found")) } })
    ]
  },
  "REC-07": {
    rows: [
      ["object", { x: 1 }],
      ["100k-chars", "x".repeat(100_000)],
      ["markup-and-path", "<script>alert(1)</script> ../x"],
      ["trailing-newline", "en\n"]
    ].flatMap(([id, locale]) => [
      row(`check-${id as string}`, [check({ locale: locale as Json })], judgedOrRefused),
      row(`submit-${id as string}`, [submit({ locale: locale as Json })], badDocument)
    ])
  },
  "REC-08": {
    rows: [
      row("unknown-sibling", [raw("submit", (context) => context.submitBody({}, (envelope) => ({ format: SIGNING_FORMAT, payload: envelope, signatures: [], smuggled: { name: "x" } })))], badDocument),
      row("no-signatures", [raw("submit", (context) => context.submitBody({}, (envelope) => ({ format: SIGNING_FORMAT, payload: envelope })))], badDocument),
      row("no-format", [raw("submit", (context) => context.submitBody({}, (envelope) => ({ payload: envelope, signatures: [] })))], badDocument),
      row("payload-not-object", [raw("submit", (context) => context.submitBody({}, () => ({ format: SIGNING_FORMAT, payload: "x", signatures: [] })))], badDocument)
    ]
  },
  "REC-09": {
    rows: [
      row("check-unknown-journey", [check({ journeyId: "no-such-journey" })], all(accepted(false), { op: "codes", includes: ["journey.unknown"] })),
      row("submit-unknown-journey", [submit({ journeyId: "no-such-journey" })], all(accepted(false), { op: "codes", includes: ["journey.unknown"] }))
    ]
  },
  "REC-10": {
    rows: [
      row("unknown-form-id", [check({ formId: UNKNOWN_FORM_ID })], refusal("not_found"), { profiles: ["submissions"] }),
      row("get-on-validate", [raw("validate", undefined, { method: "GET" })], any(refusal("method"), refusal("not_found"))),
      row("text-plain", [raw("validate", (context) => context.checkBody(), { contentType: "text/plain" })], noFailure),
      row("no-content-type", [raw("validate", (context) => new TextEncoder().encode(context.checkBody()), { contentType: null })], noFailure)
    ]
  },
  "REC-11": {
    rows: [
      row("check-hostile", [check({ values: CONTROL_VALUES["CTL-06"]() })], all(accepted(true), without("polluted", POLLUTION_MARKER, TOSTRING_MARKER))),
      row("submit-hostile", [submit({ values: CONTROL_VALUES["CTL-06"]() })], all(any(accepted(true), accepted(false)), without("polluted", POLLUTION_MARKER, TOSTRING_MARKER)))
    ]
  },
  "REC-12": {
    note: "A delivery is one submission by its submissionKey (one per submit attempt, the same on a retry). The same key and document again is answered with the first record, never refused; the same key with another document is refused 409 submission.keyConflict; a delivery without a key is refused 400 bad_document; two keys with the same answers are two records",
    rows: [
      row("same-attempt-twice", [submit({ submissionKey: `${RUN_KEY}-again` }), submit({ submissionKey: `${RUN_KEY}-again` })], { op: "answerPath", path: "outcome", equals: "same-record" }, {
        procedure: "replay-same-record",
        profiles: ["submissions"],
        skipNote: "the retry rule is the submissions service's"
      }),
      row(
        "key-reused-for-another-document",
        [submit({ submissionKey: `${RUN_KEY}-reused` }), submit({ submissionKey: `${RUN_KEY}-reused`, values: withValues({ name: "Someone Else" }) })],
        { op: "refusal", anyOf: ["outdated"], codes: ["submission.keyConflict"] },
        { profiles: ["submissions"], skipNote: "the key rule is the submissions service's" }
      ),
      row("no-key", [submit({ submissionKey: null })], badDocument, { profiles: ["submissions"], skipNote: "the key rule is the submissions service's" }),
      row("two-attempts-same-answers", [submit(), submit()], { op: "answerPath", path: "outcome", equals: "new-record" }, {
        procedure: "replay-same-record",
        profiles: ["submissions"],
        skipNote: "the key rule is the submissions service's"
      })
    ]
  },
  "REC-13": {
    rows: [
      row("check-stores-nothing", [], { op: "answerPath", path: "unchanged", equals: true }, { procedure: "validate-stores-nothing", profiles: ["submissions"], skipNote: "not observable without access to the record list, which needs a permission the suite does not ask for" })
    ]
  }
};
