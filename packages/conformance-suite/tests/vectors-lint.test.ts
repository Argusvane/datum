import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CUSTOM_PREDICATES } from "../src/customs.js";
import { BUNDLED_GOLDEN } from "../src/fixtures/golden.js";
import type { Expectation } from "../src/predicates.js";
import { VECTORS, knownSelector, matchesSelector, vectorById } from "../src/vectors/index.js";
import type { Vector, VectorInput } from "../src/vectors/schema.js";
import { REPO_ROOT } from "./helpers/paths.js";

function walkExpectation(expectation: Expectation, visit: (leaf: Expectation) => void): void {
  visit(expectation);
  if (expectation.op === "all" || expectation.op === "any") {
    expectation.of.forEach((part) => walkExpectation(part, visit));
  } else if (expectation.op === "not") {
    walkExpectation(expectation.of, visit);
  }
}

function expectationsOf(vector: Vector): Expectation[] {
  return [vector.expect, ...(vector.variants ?? []).flatMap((variant) => (variant.expect !== undefined ? [variant.expect] : []))];
}

function inputsOf(vector: Vector): VectorInput[] {
  const flatten = (input: VectorInput): VectorInput[] => (input.kind === "series" ? input.steps.flatMap(flatten) : [input]);
  return [vector.input, ...(vector.variants ?? []).flatMap((variant) => (variant.input !== undefined ? [variant.input] : []))].flatMap(flatten);
}

describe("the vector catalogue", () => {
  it("is not empty and every id is well formed and unique", () => {
    expect(VECTORS.length).toBeGreaterThan(0);
    const ids = VECTORS.map((vector) => vector.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Z]{3}-[0-9]{2,3}$/);
    }
  });

  it("keeps the id prefix in line with the class", () => {
    const prefixes: Record<string, string> = { control: "CTL", abi: "ABI", isolation: "ISO", resource: "RES", options: "OPT", files: "FIL", context: "CTX", canonical: "CAN", receiver: "REC", secrecy: "SEC", parity: "PAR", definition: "DEF", builder: "BLD", output: "OUT", journey: "JRN", test: "TST" };
    for (const vector of VECTORS) {
      expect(vector.id.slice(0, 3), vector.id).toBe(prefixes[vector.class]);
    }
  });

  it("points every provenance test at a file that exists", () => {
    for (const vector of VECTORS) {
      for (const test of vector.provenance.tests) {
        expect(existsSync(join(REPO_ROOT, test.path)), `${vector.id}: ${test.path}`).toBe(true);
      }
    }
  });

  it("names, in every provenance test, a title that occurs in the file it points at", () => {
    // The explain output prints these names; a name that no longer occurs in its file sends the reader to nothing.
    const missing: string[] = [];
    for (const vector of VECTORS) {
      for (const test of vector.provenance.tests) {
        if (test.name === undefined) continue;
        const text = readFileSync(join(REPO_ROOT, test.path), "utf8");
        if (!text.includes(test.name)) missing.push(`${vector.id}: "${test.name}" is not in ${test.path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("freezes the vectors that name no provenance test: a new vector names one, and the list only shrinks", () => {
    // A vector whose provenance is empty prints `test: none` in the explain output. These are the
    // ones that did so when the list was frozen; to remove an id from it, give that vector a test.
    const FROZEN_WITHOUT_TEST = new Set([
      "CTL-04", "ABI-02", "ABI-04", "ISO-02", "ISO-08", "FIL-02", "CTX-04", "CAN-05", "CAN-06", "CAN-07", "SEC-04", "SEC-05",
      "BLD-04", "BLD-05", "BLD-06", "BLD-07", "BLD-08", "BLD-09", "BLD-10", "BLD-11",
      "REC-01", "REC-02", "REC-03", "REC-04", "REC-09", "REC-10", "REC-11", "REC-14", "REC-16", "PAR-06"
    ]);
    const without = VECTORS.filter((vector) => vector.provenance.tests.length === 0).map((vector) => vector.id);
    expect(
      without.filter((id) => !FROZEN_WITHOUT_TEST.has(id)),
      "these vectors name no provenance test: add one to provenance.tests"
    ).toEqual([]);
    expect(
      [...FROZEN_WITHOUT_TEST].filter((id) => !without.includes(id)),
      "these vectors now name a test: remove them from the frozen list"
    ).toEqual([]);
  });

  it("uses the base fixture for every vector that runs against an endpoint", () => {
    // The builder profile's vectors (DEF, BLD) are the exception: their target is the suite-owned form the run creates, and their
    // definitions are the attack (`fixture.definitionText`), not the base form.
    const builderOnly = (entry: Vector): boolean => entry.applies.endpoint !== false && entry.applies.endpoint.profiles?.every((profile) => profile === "builder") === true;
    for (const vector of VECTORS.filter((entry) => entry.applies.endpoint !== false && !builderOnly(entry))) {
      expect(vector.fixture.definition, vector.id).toBe("base");
      expect(vector.fixture.plugins ?? [], vector.id).toEqual([]);
      for (const variant of vector.variants ?? []) {
        // A row with its own fixture cannot run against a live form: it says so, and the endpoint runner skips it.
        expect(variant.fixture === undefined || variant.programOnly === true, `${vector.id}/${variant.id}`).toBe(true);
      }
    }
  });

  it("names what blocks every pending vector", () => {
    for (const vector of VECTORS.filter((entry) => entry.gate.status === "pending")) {
      expect(vector.gate.status === "pending" ? vector.gate.blockedBy : "", vector.id).toMatch(/^[a-z][a-z -]*[a-z]$/);
    }
  });

  it("holds every DEF and BLD vector and variant to a gate that is not pending", () => {
    for (const vector of VECTORS.filter((entry) => entry.class === "definition" || entry.class === "builder")) {
      expect(vector.gate.status, vector.id).not.toBe("pending");
      for (const variant of vector.variants ?? []) {
        expect(variant.gate?.status, `${vector.id}/${variant.id}`).not.toBe("pending");
      }
    }
  });

  it("keeps the DEF and BLD vectors off the program runner's plain path where they are not program vectors", () => {
    for (const vector of VECTORS.filter((entry) => entry.class === "builder")) {
      expect(vector.applies.program, vector.id).toBe(false);
    }
    for (const vector of VECTORS.filter((entry) => entry.class === "definition")) {
      expect(vector.fixture.definitionText !== undefined || vector.variants?.some((variant) => variant.fixture?.definitionText !== undefined) === true || vector.id === "DEF-01", vector.id).toBe(true);
    }
  });

  it("gives every S1 and S2 vector a non-empty expectation", () => {
    for (const vector of VECTORS.filter((entry) => entry.severity === "S1" || entry.severity === "S2")) {
      for (const expectation of expectationsOf(vector)) {
        let leaves = 0;
        walkExpectation(expectation, (leaf) => {
          if (leaf.op !== "all" && leaf.op !== "any" && leaf.op !== "not") {
            leaves += 1;
          }
        });
        expect(leaves, vector.id).toBeGreaterThan(0);
      }
    }
  });

  it("declares variants only when there are some, each with an id and something of its own", () => {
    for (const vector of VECTORS) {
      if (vector.variants === undefined) {
        continue;
      }
      expect(vector.variants.length, vector.id).toBeGreaterThan(0);
      const ids = vector.variants.map((variant) => variant.id);
      expect(new Set(ids).size, vector.id).toBe(ids.length);
      for (const variant of vector.variants) {
        expect(variant.input !== undefined || variant.fixture !== undefined || variant.expect !== undefined, `${vector.id}/${variant.id}`).toBe(true);
      }
    }
  });

  it("refers only to registered custom predicates and to golden controls that exist", () => {
    const controls = Object.keys(BUNDLED_GOLDEN.controls);
    for (const vector of VECTORS) {
      for (const expectation of expectationsOf(vector)) {
        walkExpectation(expectation, (leaf) => {
          if (leaf.op === "custom") {
            expect(CUSTOM_PREDICATES[leaf.name], `${vector.id}: custom ${leaf.name}`).toBeDefined();
          }
          if (leaf.op === "golden") {
            expect(controls, `${vector.id}: golden ${leaf.key}`).toContain(leaf.key);
          }
        });
      }
    }
  });

  it("uses only inputs a program run understands", () => {
    for (const vector of VECTORS.filter((entry) => entry.applies.program !== false)) {
      for (const input of inputsOf(vector)) {
        expect(["values", "raw", "inspect", "detect-abi"], vector.id).toContain(input.kind);
      }
    }
  });

  it("holds the CTL, ABI and ISO classes", () => {
    expect(VECTORS.filter((vector) => vector.class === "control").map((vector) => vector.id)).toEqual(["CTL-01", "CTL-02", "CTL-03", "CTL-04", "CTL-05", "CTL-06"]);
    expect(VECTORS.filter((vector) => vector.class === "abi").map((vector) => vector.id)).toEqual(["ABI-01", "ABI-02", "ABI-03", "ABI-04", "ABI-05"]);
    expect(VECTORS.filter((vector) => vector.class === "isolation").map((vector) => vector.id)).toEqual(["ISO-01", "ISO-02", "ISO-03", "ISO-04", "ISO-05", "ISO-06", "ISO-07", "ISO-08"]);
  });

  it("selects by id, class name and class prefix, case-insensitively", () => {
    const iso03 = vectorById("ISO-03") as Vector;
    expect(matchesSelector(iso03, "ISO-03")).toBe(true);
    expect(matchesSelector(iso03, "iso-03")).toBe(true);
    expect(matchesSelector(iso03, "isolation")).toBe(true);
    expect(matchesSelector(iso03, "ISO")).toBe(true);
    expect(matchesSelector(iso03, "ctl")).toBe(false);
    expect(knownSelector("CTL")).toBe(true);
    expect(knownSelector("nope")).toBe(false);
  });

  it("has a mutation test for every enforced S1 vector (tests/mutation-programs.test.ts names it)", () => {
    const mutations = readFileSync(join(REPO_ROOT, "packages", "conformance-suite", "tests", "mutation-programs.test.ts"), "utf8");
    for (const vector of VECTORS.filter((entry) => entry.severity === "S1" && entry.gate.status === "enforced")) {
      expect(mutations, `${vector.id} has no mutation test`).toContain(`"${vector.id}"`);
    }
  });
});
