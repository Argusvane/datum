import { describe, expect, it } from "vitest";
import {
  RESULT_BYTE_LIMIT,
  capResult,
  cleanText,
  cutString,
  jsonByteLength,
  pageOf
} from "../form-engine/agent/result-caps.js";

/**
 * Caps and paging. Chrome caps nothing, so the registrar's three
 * shrinking steps and the tools' own paging are what keep a result readable by an agent.
 */
describe("pageOf", () => {
  const items = ["a", "b", "c", "d", "e"];

  it("returns the whole list without truncation when it fits", () => {
    expect(pageOf(items, 0, 10)).toEqual({ items, total: 5 });
    expect(pageOf(items, 0, 5)).toEqual({ items, total: 5 });
  });

  it("cuts at the end with truncated and nextOffset", () => {
    expect(pageOf(items, 0, 2)).toEqual({ items: ["a", "b"], total: 5, truncated: true, nextOffset: 2 });
    expect(pageOf(items, 2, 2)).toEqual({ items: ["c", "d"], total: 5, truncated: true, nextOffset: 4 });
    expect(pageOf(items, 4, 2)).toEqual({ items: ["e"], total: 5 });
  });

  it("answers an offset past the end with an empty page", () => {
    expect(pageOf(items, 9, 2)).toEqual({ items: [], total: 5 });
  });

  it("never goes negative", () => {
    expect(pageOf(items, -3, 2)).toEqual({ items: ["a", "b"], total: 5, truncated: true, nextOffset: 2 });
    expect(pageOf(items, 0, -1)).toEqual({ items: [], total: 5, truncated: true, nextOffset: 0 });
  });
});

describe("cutString", () => {
  it("passes a string at or under the cap unchanged", () => {
    expect(cutString("abc", 3)).toBe("abc");
    expect(cutString("", 3)).toBe("");
  });

  it("cuts to max - 3 characters plus an ellipsis, so 1 024 becomes 1 021 + …", () => {
    const long = "x".repeat(2000);
    const cut = cutString(long, 1024);
    expect(cut).toBe(`${"x".repeat(1021)}…`);
    expect(cut.length).toBe(1022);
    expect(jsonByteLength(cut)).toBe(1024 + 2);
  });

  it("never splits a surrogate pair", () => {
    const text = `${"a".repeat(1020)}😀${"b".repeat(10)}`;
    const cut = cutString(text, 1024);
    expect(cut).toBe(`${"a".repeat(1020)}…`);
    expect(() => JSON.parse(JSON.stringify(cut))).not.toThrow();
  });
});

describe("cleanText", () => {
  it("strips control characters, turns newlines into spaces, trims and cuts", () => {
    expect(cleanText("  Filling\nthe trip\t\u0007 details \r\n", 200)).toBe("Filling the trip details");
    expect(cleanText("x".repeat(300), 200)).toBe(`${"x".repeat(197)}…`);
    expect(cleanText("x".repeat(300), 200).length).toBeLessThanOrEqual(200);
  });

  it("answers a non-string with the empty string", () => {
    expect(cleanText(undefined, 200)).toBe("");
    expect(cleanText(5, 200)).toBe("");
  });
});

describe("capResult", () => {
  const base = { ok: true, tool: "get_answers", form: "form-1", revision: 4 };

  it("returns an envelope under the limit unchanged, by reference", () => {
    const envelope = { ...base, fields: [{ path: "a", value: "b" }] };
    expect(capResult(envelope)).toEqual({ result: envelope, truncated: false });
    expect(capResult(envelope).result).toBe(envelope);
  });

  it("step (a): cuts every string over 1 024 chars and sets truncated", () => {
    const envelope = { ...base, fields: [{ path: "a", value: "x".repeat(70_000) }], note: ["short"] };
    const { result, truncated } = capResult(envelope);
    expect(truncated).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.ok).toBe(true);
    const fields = result.fields as Array<{ value: string }>;
    expect(fields[0]?.value).toBe(`${"x".repeat(1021)}…`);
    expect(result.note).toEqual(["short"]);
    expect(jsonByteLength(result)).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
    // The input envelope is not mutated.
    expect((envelope.fields[0] as { value: string }).value.length).toBe(70_000);
  });

  it("step (b): drops inline option arrays to counts and bulky values when strings alone do not fit", () => {
    const options = Array.from({ length: 3000 }, (_, index) => ({ value: `v${index}`, label: `Label ${index}` }));
    const rows = Array.from({ length: 2000 }, (_, index) => ({ sku: `s${index}`, qty: index }));
    const envelope = {
      ...base,
      fields: [
        { path: "province", kind: "choice", options },
        { path: "items", kind: "collection", value: rows },
        { path: "receipt", kind: "file", value: { name: "r.pdf", size: 12 } },
        { path: "name", kind: "text", value: "kept" }
      ]
    };
    const { result, truncated } = capResult(envelope);
    expect(truncated).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    const fields = result.fields as Array<Record<string, unknown>>;
    expect(fields[0]).toEqual({ path: "province", kind: "choice", optionCount: 3000 });
    expect(fields[1]).toEqual({ path: "items", kind: "collection", valueOmitted: true });
    expect(fields[2]).toEqual({ path: "receipt", kind: "file", valueOmitted: true });
    expect(fields[3]).toEqual({ path: "name", kind: "text", value: "kept" });
    expect(jsonByteLength(result)).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
  });

  it("step (b) leaves a listing tool's own root options list alone: an over-cap get_options page is too-large, not emptied", () => {
    // `options` is the result's paged payload (limit up to 500, labels up to 200
    // chars). Collapsing it to optionCount would answer ok: true with no choices and a nextOffset
    // that pages past values the agent never saw; the documented answer is too-large so it lowers limit.
    const options = Array.from({ length: 500 }, (_, index) => ({
      value: `value-${index}`.padEnd(60, "v"),
      label: `Label ${index} `.padEnd(200, "l"),
      selected: index === 3
    }));
    const envelope = {
      ...base,
      tool: "get_options",
      field: { path: "costCentre", id: "cost-centre", label: "Cost centre", kind: "choice" },
      options,
      total: 5000,
      source: "data-source",
      status: "ready",
      acceptsFreeText: false,
      current: ["value-3"],
      truncated: true,
      nextOffset: 500
    };
    const got = jsonByteLength(envelope);
    expect(got).toBeGreaterThan(RESULT_BYTE_LIMIT);
    const { result, truncated } = capResult(envelope);
    expect(truncated).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("too-large");
    expect(result.details).toEqual({ what: "result", limit: RESULT_BYTE_LIMIT, got });
    expect("options" in result).toBe(false);
    expect("optionCount" in result).toBe(false);
    expect("nextOffset" in result).toBe(false);
  });

  it("steps (a) then (b) compound: strings stay cut when the option list is dropped", () => {
    const options = Array.from({ length: 3000 }, (_, index) => ({ value: `v${index}`, label: `Label ${index}` }));
    const envelope = {
      ...base,
      fields: [
        { path: "notes", kind: "text", value: "x".repeat(70_000) },
        { path: "province", kind: "choice", options }
      ]
    };
    const { result, truncated } = capResult(envelope);
    expect(truncated).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    const fields = result.fields as Array<Record<string, unknown>>;
    expect(fields[0]).toEqual({ path: "notes", kind: "text", value: `${"x".repeat(1021)}…` });
    expect(fields[1]).toEqual({ path: "province", kind: "choice", optionCount: 3000 });
    expect(jsonByteLength(result)).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
  });

  it("step (c): replaces an unpageable result with too-large, keeping tool, form and revision", () => {
    const blob = Array.from({ length: 20_000 }, (_, index) => ({ id: index, text: "unpageable entry" }));
    const envelope = { ...base, entries: blob };
    const got = jsonByteLength(envelope);
    const { result, truncated } = capResult(envelope);
    expect(truncated).toBe(true);
    expect(result).toEqual({
      ok: false,
      tool: "get_answers",
      form: "form-1",
      revision: 4,
      code: "too-large",
      message: `The result is ${got} bytes, over the ${RESULT_BYTE_LIMIT} byte limit.`,
      hint: "Use offset/limit, a narrower scope, or paths.",
      retryable: false,
      details: { what: "result", limit: RESULT_BYTE_LIMIT, got }
    });
    expect(jsonByteLength(result)).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
  });

  it("step (c) reports the size the tool produced, not the size after (a) and (b) shrank it", () => {
    const blob = Array.from({ length: 20_000 }, (_, index) => ({ id: index, text: "unpageable entry" }));
    const envelope = { ...base, text: "t".repeat(5000), entries: blob };
    const original = jsonByteLength(envelope);
    const { result } = capResult(envelope);
    expect(result.code).toBe("too-large");
    expect(result.message).toBe(`The result is ${original} bytes, over the ${RESULT_BYTE_LIMIT} byte limit.`);
    expect((result.details as { got: number }).got).toBe(original);
  });

  it("keeps builder on a builder envelope and omits form, revision when absent", () => {
    const envelope = { ok: true, tool: "get_outline", builder: "builder-1", nodes: Array.from({ length: 9000 }, (_, i) => ({ i })) };
    const { result } = capResult(envelope, 1000);
    expect(result.builder).toBe("builder-1");
    expect("form" in result).toBe(false);
    expect("revision" in result).toBe(false);
    expect(result.code).toBe("too-large");
  });

  it("honours a custom limit", () => {
    const envelope = { ...base, text: "y".repeat(5000) };
    const { result } = capResult(envelope, 2000);
    expect(result.text).toBe(`${"y".repeat(1021)}…`);
    expect(jsonByteLength(result)).toBeLessThanOrEqual(2000);
  });
});
