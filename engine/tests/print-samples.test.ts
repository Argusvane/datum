import { describe, expect, it } from "vitest";

import { readPastedAnswers, readReceiptData, readSampleSourceValue, sampleSourceValue, submissionValuesOf } from "../form-engine/builder/print/print-samples.js";

/** The Print workspace's sample answers and receipt: read from what the author pastes, never thrown on. */
describe("readPastedAnswers", () => {
  const values = { fullName: "Ada Lovelace", "address.zip": "K1A 0B1" };

  it("takes the answers alone", () => {
    expect(readPastedAnswers(JSON.stringify(values))).toEqual({ value: values });
  });

  it("takes the answers out of a submission envelope and a signed wrapper around one", () => {
    const envelope = { versionContext: { formId: "f", formVersion: "1" }, submission: { locale: "en", values } };
    expect(readPastedAnswers(JSON.stringify(envelope))).toEqual({ value: values });
    expect(readPastedAnswers(JSON.stringify({ format: "jws", payload: envelope, signatures: [] }))).toEqual({ value: values });
  });

  it("takes a record's judged values, else its delivered document's", () => {
    const judged = { fullName: "Judged" };
    const record = { id: "r1", formId: "f", digest: "abc", receivedAt: "2026-11-16T00:00:00Z", document: { submission: { values } }, values: judged };
    expect(readPastedAnswers(JSON.stringify(record))).toEqual({ value: judged });
    const { values: _dropped, ...unjudged } = record;
    expect(readPastedAnswers(JSON.stringify(unjudged))).toEqual({ value: values });
    expect(readPastedAnswers(JSON.stringify({ ...unjudged, document: { format: "jws", payload: { submission: { values } } } }))).toEqual({ value: values });
  });

  it("says why it cannot read a paste, and nothing for an empty box", () => {
    expect(readPastedAnswers("")).toEqual({ empty: true });
    expect(readPastedAnswers("   ")).toEqual({ empty: true });
    expect(readPastedAnswers("{ not json")).toEqual({ error: "json" });
    expect(readPastedAnswers("[1, 2]")).toEqual({ error: "shape" });
    expect(readPastedAnswers("42")).toEqual({ error: "shape" });
    expect(readPastedAnswers("null")).toEqual({ error: "shape" });
    expect(() => readPastedAnswers(undefined as never)).not.toThrow();
  });

  it("drops prototype keys and shares nothing with what it parsed", () => {
    const reading = readPastedAnswers('{ "__proto__": { "polluted": true }, "constructor": 1, "name": "x" }');
    expect(reading).toEqual({ value: { name: "x" } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(submissionValuesOf("text")).toBeUndefined();
  });
});

describe("readReceiptData", () => {
  it("takes a JSON object and refuses anything else", () => {
    expect(readReceiptData('{ "reference": "CG-1" }')).toEqual({ value: { reference: "CG-1" } });
    expect(readReceiptData("")).toEqual({ empty: true });
    expect(readReceiptData("{")).toEqual({ error: "json" });
    expect(readReceiptData('"CG-1"')).toEqual({ error: "shape" });
  });
});

describe("the sample picker's values", () => {
  it("round-trips every source and reads an unknown value as none", () => {
    for (const source of [{ kind: "none" }, { kind: "try" }, { kind: "pasted" }, { kind: "scenario", id: "t1" }] as const) {
      expect(readSampleSourceValue(sampleSourceValue(source))).toEqual(source);
    }
    expect(readSampleSourceValue("scenario:")).toEqual({ kind: "none" });
    expect(readSampleSourceValue("bogus")).toEqual({ kind: "none" });
  });
});
