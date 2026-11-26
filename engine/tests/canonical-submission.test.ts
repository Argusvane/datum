import { describe, expect, it } from "vitest";

import {
  canonicalizeSubmission,
  serializeCanonicalSubmission,
  signedCanonicalOf
} from "../form-engine/core/submission/canonical-submission.js";
import { kernelStableStringify } from "../form-engine/validation/wasm/portable-kernel.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";

describe("canonical submission", () => {
  it("produces stable key ordering", () => {
    const submission = {
      versionContext: {
        form: { id: "f1", version: "1" },
        client: {
          runtimeVersion: "0.1.0",
          rendererVersion: "0.1.0",
          schemaVersion: "1",
          components: { b: "1.0.0", a: "1.0.0" }
        }
      },
      submission: {
        locale: "fr-CA",
        values: { z: 1, a: 2 }
      }
    };

    const canonical = canonicalizeSubmission(submission);
    expect(Object.keys(canonical.submission.values)).toEqual(["a", "z"]);
    expect(Object.keys(canonical.versionContext.client.components ?? {})).toEqual([
      "a",
      "b"
    ]);
  });

  it("serializes deterministically", () => {
    const payload = {
      versionContext: {
        form: { id: "f1", version: "1" },
        client: {
          runtimeVersion: "0.1.0",
          rendererVersion: "0.1.0",
          schemaVersion: "1"
        }
      },
      submission: {
        locale: "en-CA",
        values: { a: 1 }
      }
    };

    const one = serializeCanonicalSubmission(payload);
    const two = serializeCanonicalSubmission(payload);
    expect(one).toBe(two);
  });

  it("sorts keys by code unit, as the sandbox kernel does, where ICU collation would differ", () => {
    const envelope = {
      versionContext: { form: { id: "f", version: "1" }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } },
      submission: { locale: "en", values: { B: 1, a: 2, Ab: 3, aa: 4, "a-b": 5, a_b: 6, "a.b": 7, "a b": 8, "\u{1F600}": 9, "\uFFFD": 10, z: 11 } }
    };
    const serialized = serializeCanonicalSubmission(envelope);
    expect(serialized).toBe(kernelStableStringify(envelope));
    expect(Object.keys(canonicalizeSubmission(envelope).submission.values)).toEqual([
      "Ab", "B", "a", "a b", "a-b", "a.b", "a_b", "aa", "z", "\u{1F600}", "\uFFFD"
    ]);
  });

  it("signs in RFC 8785, keys in code-unit order", () => {
    const envelope = {
      versionContext: { form: { id: "f", version: "1" }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } },
      submission: { locale: "en", values: { B: 1, a: 2 } }
    };
    expect(signedCanonicalOf(envelope, "values")).toBe('{"B":1,"a":2}');
  });

  it("registers and resolves submission modes", () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "validate-and-sign", validate: true, sign: true, serverValidation: true });

    const mode = modes.resolve("validate-and-sign");
    expect(mode.sign).toBe(true);
  });
});
