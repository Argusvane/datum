import { describe, expect, it } from "vitest";

import { serializeCanonicalSubmission } from "../form-engine/core/submission/canonical-submission.js";
import {
  serializeSubmissionFile,
  submissionFileName
} from "../form-engine/core/submission/submission-file.js";

const submission = {
  versionContext: {
    form: { id: "Customer Intake/v2", version: "2.0.0" },
    client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" }
  },
  submission: {
    locale: "en",
    values: { z: "last", a: "first", nested: { b: 2, a: 1 } }
  }
};

describe("submission file", () => {
  it("holds the canonical envelope itself, pretty-printed in stable key order", () => {
    const text = serializeSubmissionFile(submission);

    // What a person opens is the same envelope every other delivery route carries.
    expect(JSON.parse(text)).toEqual(JSON.parse(serializeCanonicalSubmission(submission)));
    // Readable: indented, one key per line.
    expect(text).toContain('\n  "submission": {\n    "locale": "en",');
    // Deterministic: object keys sorted at every level, so two saves of the same answers match.
    expect(Object.keys((JSON.parse(text) as typeof submission).submission.values)).toEqual(["a", "nested", "z"]);
    expect(text).toBe(serializeSubmissionFile({ ...submission, submission: { ...submission.submission, values: { a: "first", z: "last", nested: { a: 1, b: 2 } } } }));
  });

  it("names the file after the form and the local time it was saved", () => {
    const at = new Date(2026, 8, 4, 9, 5, 7); // local components, so the stamp is the same in any zone
    expect(submissionFileName(submission, at)).toBe("Customer-Intake-v2-submission-20260904-090507.json");
  });

  it("falls back to a generic name when the form id has no file-safe characters", () => {
    const at = new Date(2026, 0, 1, 0, 0, 0);
    const unnamed = { ...submission, versionContext: { ...submission.versionContext, form: { id: "///", version: "1" } } };
    expect(submissionFileName(unnamed, at)).toBe("form-submission-20260101-000000.json");
  });

  it("stamps the current time when none is given", () => {
    expect(submissionFileName(submission)).toMatch(/^Customer-Intake-v2-submission-\d{8}-\d{6}\.json$/);
  });
});
