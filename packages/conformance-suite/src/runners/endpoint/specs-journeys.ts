import { validValues } from "../../fixtures/base-form.js";
import type { Json } from "../../observation.js";
import type { Expectation } from "../../predicates.js";
import type { EndpointRow, EndpointSpec, RequestSpec } from "./rows.js";

/**
 * JRN: journeys on the wire. The fixture form's journey `main` routes the name "STOPZZ" to an
 * exit page, so a submission with that name must be refused (`journey.exit`) whenever it is
 * judged by `main`. The rows ask what a receiver does when the request names a journey badly or
 * not at all:
 *
 * - JRN-01: `main` named, the exit answers, check and submission.
 * - JRN-03: hostile and wrong-typed journey ids are `journey.unknown`.
 * - JRN-07: journey left out -> the default journey (so the exit page still refuses) or
 *   `journey.required`; never an accepted submission that skipped the exit.
 */
const accepted = (value: boolean): Expectation => ({ op: "accepted", value });
const all = (...of: Expectation[]): Expectation => ({ op: "all", of });
const any = (...of: Expectation[]): Expectation => ({ op: "any", of });
const codes = (...includes: string[]): Expectation => ({ op: "codes", includes });

const exitRefused: Expectation = all(accepted(false), codes("journey.exit"));
const malformed: Expectation = { op: "refusal", anyOf: ["bad_document"] };
const unknownJourney: Expectation = all(accepted(false), codes("journey.unknown"));
/** The two ways to keep the exit page: judge by the default journey, or refuse to judge. */
const exitKept: Expectation = any(exitRefused, all(accepted(false), codes("journey.required")));

const check = (parts: Omit<Extract<RequestSpec, { kind: "check" }>, "kind"> = {}): RequestSpec => ({ kind: "check", ...parts });
const submit = (parts: Omit<Extract<RequestSpec, { kind: "submit" }>, "kind"> = {}): RequestSpec => ({ kind: "submit", ...parts });
const row = (id: string, requests: RequestSpec[], expect: Expectation, rest: Partial<EndpointRow> = {}): EndpointRow => ({ id, requests, expect, ...rest });

/** Answers that reach the exit page of `main`: a valid submission whose name is STOPZZ. */
const exitValues = (): Json => ({ ...(validValues() as Record<string, Json>), name: "STOPZZ" });

const HOSTILE_IDS: [string, Json][] = [
  ["proto", "__proto__"],
  ["constructor", "constructor"],
  ["tostring", "toString"],
  ["number", 7]
];

/** The rows of JRN-07: a journey left out, judged by what a receiver is meant to do. The service reads `{id: null}` as an unknown journey, so no null-id rows. */
function omissionRows(expect: Expectation): EndpointRow[] {
  return [
    row("check-omitted-with-the-exit-answers", [check({ journeyId: null, values: exitValues() })], expect),
    row("submit-omitted-with-the-exit-answers", [submit({ journeyId: null, values: exitValues() })], expect)
  ];
}

export const JOURNEY_ENDPOINT_SPECS: Record<string, EndpointSpec> = {
  "JRN-01": {
    note: "needs the fixture with the exit route (the current securitySuiteFixture): if the first row is accepted, reinstall the fixture",
    rows: [
      row("check-the-exit-answers-through-main", [check({ values: exitValues() })], exitRefused),
      row("submit-the-exit-answers-through-main", [submit({ values: exitValues() })], exitRefused),
      row("control-honest-answers-through-main", [check()], accepted(true))
    ]
  },
  "JRN-03": {
    rows: [
      ...HOSTILE_IDS.map(([id, value]) => row(`check-id-${id}`, [check({ journeyIdRaw: value })], typeof value === "string" ? unknownJourney : any(unknownJourney, malformed))),
      row("submit-id-proto", [submit({ journeyIdRaw: "__proto__" })], unknownJourney),
      // A typed-wrong id may be refused as a malformed document (400 bad_document) or as an unknown journey.
      row("submit-id-number", [submit({ journeyIdRaw: 7 })], any(unknownJourney, malformed))
    ]
  },
  "JRN-07": {
    note: "a journey left out is the form's only or declared default journey, else journey.required",
    rows: omissionRows(exitKept)
  }
};
