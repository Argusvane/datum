import { describe, expect, it } from "vitest";

import { resolveErrorPresentationPolicy } from "../form-engine/render/core/render-policy.js";

describe("render policy", () => {
  it("preserves summary even when inline component errors are hidden", () => {
    const policy = resolveErrorPresentationPolicy({
      showComponentErrors: false,
      showErrorSummary: true,
      errorSummaryPosition: "top",
      focusFirstError: true
    });

    expect(policy.showInlineErrors).toBe(false);
    expect(policy.showSummary).toBe(true);
  });

  it("applies defaults", () => {
    const policy = resolveErrorPresentationPolicy({
      showComponentErrors: true,
      showErrorSummary: true
    });

    expect(policy.summaryPosition).toBe("top");
    expect(policy.focusFirstError).toBe(true);
  });

  it("takes the definition's focusFirstError when the host says nothing, and the host's over it", () => {
    const plain = { showComponentErrors: true, showErrorSummary: true };
    expect(resolveErrorPresentationPolicy(plain, false).focusFirstError).toBe(false);
    expect(resolveErrorPresentationPolicy(plain, true).focusFirstError).toBe(true);
    expect(resolveErrorPresentationPolicy(plain, undefined).focusFirstError).toBe(true);
    expect(resolveErrorPresentationPolicy({ ...plain, focusFirstError: true }, false).focusFirstError).toBe(true);
    expect(resolveErrorPresentationPolicy({ ...plain, focusFirstError: false }, true).focusFirstError).toBe(false);
  });
});
