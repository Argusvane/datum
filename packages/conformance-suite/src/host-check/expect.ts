import { asString, jsonEquals, path, shown } from "./json.js";
import type { Reply } from "./http.js";

/**
 * The case model's assertions. A failed one throws {@link CaseFailure} (JUnit's AssertionError: the
 * case FAILs); an unmet assumption throws {@link CaseSkipped} (JUnit's assumption: the case is
 * SKIPPED, never passed). Messages name the request and the answer, as the Java kit's
 * `.as(reply.toString())` does.
 */
export class CaseFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseFailure";
  }
}

export class CaseSkipped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseSkipped";
  }
}

/** Fails the case unless `condition` holds. */
export function check(condition: boolean, message: string | (() => string)): asserts condition {
  if (!condition) throw new CaseFailure(typeof message === "function" ? message() : message);
}

/** Skips the case unless `condition` holds (Assumptions.assumeTrue). */
export function assume(condition: boolean, message: string): asserts condition {
  if (!condition) throw new CaseSkipped(message);
}

/** The status is `expected` (or one of them). */
export function expectStatus(reply: Reply, expected: number | readonly number[], what?: string): void {
  const allowed = typeof expected === "number" ? [expected] : expected;
  check(allowed.includes(reply.status), () => `${what !== undefined ? `${what}: ` : ""}expected HTTP ${allowed.join(" or ")}, got ${reply.describe()}`);
}

/** The first error's code is `expected` (or one of them); the body must be a Datum error body. */
export function expectCode(reply: Reply, expected: string | readonly string[], what?: string): void {
  const allowed = typeof expected === "string" ? [expected] : expected;
  const code = reply.code();
  check(allowed.includes(code), () => `${what !== undefined ? `${what}: ` : ""}expected code ${allowed.join(" or ")}, got ${code === "" ? "none" : JSON.stringify(code)} in ${reply.describe()}`);
}

/**
 * The header is present (and, when `test` is given, its first value equals the string, matches the
 * whole pattern, or passes the function). Returns the value.
 */
export function expectHeader(reply: Reply, name: string, test?: string | RegExp | ((value: string) => boolean), what?: string): string {
  const value = reply.header(name);
  check(value !== undefined, () => `${what !== undefined ? `${what}: ` : ""}no ${name} header on ${reply.describe()} (headers: ${reply.headerNames().join(", ")})`);
  if (test !== undefined) {
    const ok = typeof test === "string" ? value === test : test instanceof RegExp ? wholeMatch(test, value) : test(value);
    check(ok, () => `${what !== undefined ? `${what}: ` : ""}${name} is ${JSON.stringify(value)}, expected ${typeof test === "string" ? JSON.stringify(test) : test instanceof RegExp ? String(test) : "another value"}`);
  }
  return value;
}

/** The body as JSON; fails the case when it is not (Reply.json()). */
export function expectJson(reply: Reply): unknown {
  return reply.json();
}

/** Deep JSON equality (JsonNode.equals). */
export function expectJsonEqual(actual: unknown, expected: unknown, what: string): void {
  check(jsonEquals(actual, expected), () => `${what}: expected ${shown(expected)}, got ${shown(actual)}`);
}

/** Strict equality of two scalars. */
export function expectEqual<T>(actual: T, expected: T, what: string): void {
  check(Object.is(actual, expected), () => `${what}: expected ${shown(expected)}, got ${shown(actual)}`);
}

/** A whole-string match (Java's String.matches). */
export function expectMatches(actual: string, pattern: RegExp, what: string): void {
  check(wholeMatch(pattern, actual), () => `${what}: ${JSON.stringify(actual)} does not match ${String(pattern)}`);
}

/** The text holds `part`. */
export function expectContains(text: string, part: string, what: string): void {
  check(text.includes(part), () => `${what}: does not contain ${JSON.stringify(part)}`);
}

/** The text does not hold `part`. */
export function expectNotContains(text: string, part: string, what: string): void {
  check(!text.includes(part), () => `${what}: contains ${JSON.stringify(part)}`);
}

/** Two sorted string sets are equal. */
export function expectSet(actual: readonly string[], expected: readonly string[], what: string): void {
  check(actual.length === expected.length && actual.every((item, index) => item === expected[index]), () => `${what}: expected [${expected.join(", ")}], got [${actual.join(", ")}]`);
}

/** The member's text (Jackson `path(...).asString()`). */
export function textAt(value: unknown, ...keys: (string | number)[]): string {
  return asString(path(value, ...keys));
}

function wholeMatch(pattern: RegExp, value: string): boolean {
  const anchored = new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace(/[gy]/g, ""));
  return anchored.test(value);
}
