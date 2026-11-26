import { describe, expect, it } from "vitest";
import { agentBuilder } from "./fixtures/agent-builder.js";
import { PROBLEM_CAP, RESULT_BYTE_LIMIT, RESULT_STRING_CAP, WARNING_CAP, capRefusal, capWarnings, jsonByteLength } from "../form-engine/agent/result-caps.js";

describe("refusals and warnings stay under the result cap", () => {
  it("a bad-input refusal keeps its code and the first problems, counts the rest", async () => {
    const builder = agentBuilder();
    const result: any = await builder.execute("set_properties", { edits: Array.from({ length: 20_000 }, (_, i) => i) });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("bad-input");
    expect(result.retryable).toBe(false);
    expect(typeof result.hint).toBe("string");
    expect(typeof result.revision).toBe("number");
    expect(result.details.problems).toHaveLength(PROBLEM_CAP);
    expect(result.details.problems[0].key).toBe("edits[0]");
    expect(result.details.truncated).toBe(true);
    expect(result.details.totalProblems).toBe(20_000);
    expect(jsonByteLength(result)).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
  });

  it("a refusal with thousands of stray-key warnings lists a few and counts the rest", async () => {
    const builder = agentBuilder();
    const input: Record<string, unknown> = { edits: 5 };
    for (let i = 0; i < 3_000; i += 1) {
      input[`stray_${i}_${"x".repeat(100)}`] = 1;
    }
    const result: any = await builder.execute("set_properties", input);
    expect(result.code).toBe("bad-input");
    expect(result.warnings).toHaveLength(WARNING_CAP + 1);
    expect(result.warnings[WARNING_CAP]).toContain("2980 more warnings");
    expect(jsonByteLength(result)).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
  });

  it("the too-large refusal does not get the uncapped warnings back", async () => {
    const builder = agentBuilder();
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 3_000; i += 1) {
      input[`stray_${i}_${"x".repeat(100)}`] = 1;
    }
    const result: any = await builder.execute("describe_builder", input);
    expect(jsonByteLength(result)).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
    expect((result.warnings ?? []).length).toBeLessThanOrEqual(WARNING_CAP + 1);
  });

  it("an honest handful of problems and warnings passes unchanged", () => {
    const envelope = { ok: false, code: "bad-input", details: { problems: [{ key: "a", expected: "a string" }] } };
    expect(capRefusal(envelope)).toBe(envelope);
    expect(capWarnings(["one", "two"])).toEqual(["one", "two"]);
  });

  it("a few warnings keep up to a kilobyte each; past the cap each is cut to 200 characters", () => {
    const honest = `derived-option-values: ${"province_or_territory_3, ".repeat(30)}`;
    expect(honest.length).toBeGreaterThan(600);
    expect(capWarnings([honest, "two"])).toEqual([honest, "two"]);
    const many = capWarnings(Array.from({ length: WARNING_CAP + 5 }, () => honest));
    expect(many).toHaveLength(WARNING_CAP + 1);
    expect(many[0]?.length).toBeLessThanOrEqual(200);
    const huge = capWarnings(["w".repeat(5_000)]);
    expect(huge[0]?.length).toBeLessThanOrEqual(RESULT_STRING_CAP);
    expect(huge[0]?.length).toBeGreaterThan(200);
  });

  it("capRefusal cuts long strings, then drops details, but never the code", () => {
    const long = "k".repeat(200_000);
    const cut: any = capRefusal({ ok: false, code: "unknown-field", message: long, hint: "h", retryable: false, details: { key: long } });
    expect(cut.code).toBe("unknown-field");
    expect(jsonByteLength(cut)).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
    const wide: any = capRefusal({
      ok: false,
      code: "x",
      hint: "h",
      retryable: false,
      details: { rows: Array.from({ length: 5_000 }, (_, i) => `row ${i} ${"y".repeat(100)}`) }
    });
    expect(wide.code).toBe("x");
    expect(wide.details.truncated).toBe(true);
    expect(jsonByteLength(wide)).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
  });
});
