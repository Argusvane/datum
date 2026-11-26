import { describe, expect, it } from "vitest";

import { parseSubmissionDocument } from "../src/index.js";

const ENVELOPE = {
  versionContext: { form: { id: "intake", version: "1.0.0" }, client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1.0.0" } },
  submission: { locale: "en", values: { name: "Ada" } }
};

describe("parseSubmissionDocument", () => {
  it("reads an envelope, a signed wrapper and bare answers", () => {
    expect(parseSubmissionDocument(JSON.stringify(ENVELOPE))).toMatchObject({ kind: "envelope", document: { submission: { locale: "en" } } });
    const wrapper = { format: { scope: "envelope", placement: "wrapper", digest: "sha-256", canonicalization: "jcs" }, payload: ENVELOPE, signatures: [{ signature: "demo", algorithm: "demo-none", signedAt: 0, participantId: "p" }] };
    expect(parseSubmissionDocument(JSON.stringify(wrapper))).toMatchObject({ kind: "wrapper", document: { payload: { submission: { locale: "en" } }, signatures: [{ algorithm: "demo-none" }] } });
    expect(parseSubmissionDocument(JSON.stringify({ values: { name: "Ada" }, locale: "fr" }))).toEqual({ kind: "bare", values: { name: "Ada" }, locale: "fr" });
  });

  it("refuses what it cannot read, saying why", () => {
    expect(() => parseSubmissionDocument("{")).toThrow(/not valid JSON/);
    expect(() => parseSubmissionDocument("[]")).toThrow(/submission object/);
    expect(() => parseSubmissionDocument(JSON.stringify({ submission: { values: 1 } }))).toThrow(/submission\.values/);
    expect(() => parseSubmissionDocument(JSON.stringify({ submission: { values: {}, locale: "en" } }))).toThrow(/versionContext\.form\.id/);
    expect(() => parseSubmissionDocument(JSON.stringify({ payload: ENVELOPE }))).toThrow(/list its signatures/);
    expect(() => parseSubmissionDocument(JSON.stringify({ payload: ENVELOPE, signatures: [] }))).toThrow(/signing format/);
    expect(() => parseSubmissionDocument(JSON.stringify({ values: { a: 1 }, locale: 3 }))).toThrow(/locale/);
    expect(() => parseSubmissionDocument(JSON.stringify({ nothing: true }))).toThrow(/values object/);
  });
});
