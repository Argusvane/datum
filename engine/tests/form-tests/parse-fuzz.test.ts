import { describe, expect, it } from "vitest";

import { formulaFunctionSignatures } from "../../form-engine/core/expressions/function-table.js";
import { kernelParseFormTests } from "../../form-engine/core/form-tests/form-test-parse.js";
import type { FormTestParseResult } from "../../form-engine/core/form-tests/form-test-types.js";

// A mutation fuzz over valid scenarios: whatever the text, the parser
// returns a well-formed result and never throws. The generator is a small LCG so a failing run
// reproduces from its iteration number.

const signatures = formulaFunctionSignatures();

const VALID: string[] = [
  [
    'test "adult applies"',
    'given today = @"2026-03-14"',
    'given locale = "fr-CA"',
    "given journey = main",
    'given host.role = "admin"',
    'given options for province = ("ON", "QC")',
    "set age = 30",
    'set name = "Ada Lovelace"',
    'set topics = ("a", "b")',
    "continue",
    "expect page = review",
    "expect accepted"
  ].join("\n"),
  [
    'test "rows"  # trailing comment',
    "add row to items with qty = 2, label = 'x'",
    "remove row 0 of items",
    "expect rows of items = 0",
    "set items[0].qty = -3.5e2",
    "clear items[0].qty",
    "expect items[0].qty required",
    "expect items[0].qty not empty"
  ].join("\n"),
  [
    'test "errors"',
    "submit",
    "expect refused",
    "expect error on email: required",
    'expect message on email = "Enter an email address."',
    "expect no error on name",
    "expect no errors",
    "expect secret withheld",
    'expect submitted name = "Ada"'
  ].join("\n"),
  [
    'test "formulas"',
    "set subtotal = 100",
    "expect total = subtotal * 1.13",
    "expect count(selected(services)) <= 3",
    "expect total = 113",
    "expect total != 0",
    "expect age between 18 and 65",
    "expect (1 + 2) * 3 = 9"
  ].join("\n"),
  [
    'test "journey"',
    'skip "waiting on the rule"',
    "back",
    "go to review",
    "check",
    "expect path = (start, review, done)",
    "expect path ends at stop",
    "expect review on path",
    "expect review off path",
    "expect layout = summary"
  ].join("\n")
];

const ALPHABET = ['"', "'", "(", ")", ",", "=", "!", ":", "#", "\n", " ", "\\", "@", "[", "]", ".", "-", "0", "9", "a", "Z", "“", "’", "é", "\ud83d", "\ude00", "\r", "\t"];

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function mutate(source: string, next: () => number): string {
  let out = source;
  const count = 1 + Math.floor(next() * 4);
  for (let n = 0; n < count && out.length > 0; n += 1) {
    const at = Math.floor(next() * out.length);
    const kind = Math.floor(next() * 4);
    if (kind === 0) {
      out = out.slice(0, at) + out.slice(at + 1 + Math.floor(next() * 3));
    } else if (kind === 1) {
      const ch = ALPHABET[Math.floor(next() * ALPHABET.length)] ?? "x";
      out = out.slice(0, at) + ch + out.slice(at);
    } else if (kind === 2) {
      const length = 1 + Math.floor(next() * 12);
      out = out.slice(0, at) + out.slice(at, at + length) + out.slice(at);
    } else {
      const other = Math.floor(next() * out.length);
      const low = Math.min(at, other);
      const high = Math.max(at, other);
      out = out.slice(0, low) + out.charAt(high) + out.slice(low + 1, high) + out.charAt(low) + out.slice(high + 1);
    }
  }
  return out;
}

function checkShape(result: FormTestParseResult, source: string, label: string): void {
  expect(Array.isArray(result.scenarios), label).toBe(true);
  expect(Array.isArray(result.problems), label).toBe(true);
  expect(result.ok, label).toBe(result.problems.length === 0);
  // A carriage return alone ends a line too.
  const lines = source.split(/\r\n|\r|\n/).length;
  for (const problem of result.problems) {
    expect(problem.line, label).toBeGreaterThanOrEqual(1);
    expect(problem.line, label).toBeLessThanOrEqual(lines);
    expect(problem.start, label).toBeGreaterThanOrEqual(0);
    expect(problem.end, label).toBeGreaterThanOrEqual(problem.start);
    expect(problem.end, label).toBeLessThanOrEqual(source.length);
  }
  for (const scenario of result.scenarios) {
    expect(Array.isArray(scenario.givens), label).toBe(true);
    expect(Array.isArray(scenario.steps), label).toBe(true);
    expect(Array.isArray(scenario.refs), label).toBe(true);
    for (const ref of scenario.refs) {
      expect(ref.span.start, label).toBeGreaterThanOrEqual(0);
      expect(ref.span.end, label).toBeLessThanOrEqual(source.length);
      expect(source.slice(ref.span.start, ref.span.end).length, label).toBeGreaterThan(0);
    }
  }
}

describe("the form-test parser under mutation", () => {
  it("parses the unmutated blocks cleanly", () => {
    for (const block of VALID) {
      const result = kernelParseFormTests(block, signatures);
      expect(result.problems).toEqual([]);
      expect(result.scenarios).toHaveLength(1);
    }
    const all = kernelParseFormTests(VALID.join("\n\n"), signatures);
    expect(all.problems).toEqual([]);
    expect(all.scenarios).toHaveLength(5);
  });

  it("returns a well-formed result for 2,000 seeded mutations and never throws", () => {
    const next = lcg(20261023);
    for (let i = 0; i < 2000; i += 1) {
      const base = VALID[i % VALID.length]!;
      const source = i % 7 === 0 ? mutate(VALID.join("\n"), next) : mutate(base, next);
      let result: FormTestParseResult | undefined;
      expect(() => {
        result = kernelParseFormTests(source, signatures);
      }, `iteration ${i}`).not.toThrow();
      checkShape(result!, source, `iteration ${i}: ${JSON.stringify(source)}`);
    }
  });

  it("answers for input that is not text, and for a missing signature list", () => {
    expect(kernelParseFormTests(undefined as unknown as string, signatures)).toEqual({ ok: true, scenarios: [], problems: [] });
    expect(kernelParseFormTests(42 as unknown as string, signatures).scenarios).toEqual([]);
    expect(kernelParseFormTests('test "a"\nexpect f(1) = 2', undefined as unknown as []).problems[0]?.code).toBe("badFormula");
  });

  it("returns quickly for 100,000 open brackets wherever a value or a formula can start", () => {
    const brackets = "(".repeat(100000);
    const lines = [
      brackets,
      `set a = ${brackets}`,
      `given host.x = ${brackets}`,
      `given options for x = ${brackets}`,
      `expect ${brackets}`,
      `expect total = ${brackets}`,
      `expect path = ${brackets}`,
      `expect total > ${"(".repeat(49000)}1${")".repeat(49000)}`
    ];
    for (const line of lines) {
      const source = `test "t"\n${line}`;
      const started = performance.now();
      const result = kernelParseFormTests(source, signatures);
      const elapsed = performance.now() - started;
      expect(elapsed, line.slice(0, 20)).toBeLessThan(200);
      expect(result.ok).toBe(false);
      expect(result.scenarios).toHaveLength(1);
    }
  });

  it("returns quickly for long flat input of other shapes", () => {
    const shapes = [
      "x ".repeat(50000),
      '"'.repeat(99999),
      "a,".repeat(49000),
      "\n".repeat(99999),
      'test "a"\n'.repeat(12000),
      "set a = 1\n".repeat(15000)
    ];
    for (const shape of shapes) {
      const started = performance.now();
      kernelParseFormTests(`test "t"\n${shape}`, signatures);
      expect(performance.now() - started).toBeLessThan(2000);
    }
    const flat = `test "t"\nexpect ${"a + ".repeat(20000)}1`;
    const started = performance.now();
    expect(kernelParseFormTests(flat, signatures).problems.length).toBeLessThanOrEqual(1);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
