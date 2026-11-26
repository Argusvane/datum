import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CAPABILITY_ORDER } from "../../src/host-check/capabilities.js";
import { titleOf } from "../../src/host-check/case.js";
import { CASES, MODULES } from "../../src/host-check/cases/index.js";
import { REPO_ROOT } from "../helpers/paths.js";

const CONTRACTS = join(REPO_ROOT, "integrations/jvm/tck/datum-host-tck/src/main/java/com/argusvane/datum/tck");

/** An @Order as the number JUnit sorts by (`Order.DEFAULT + 9000` is 1073741823 + 9000). */
function orderValue(order: string): number {
  const offset = /^Order\.DEFAULT\s*\+\s*(\d+)$/.exec(order);
  return offset !== null ? 1073741823 + Number(offset[1]) : Number(order);
}

/**
 * The @Test methods of a Java contract with their @Order, in the order JUnit runs them (`@Order` ascending, as HostContract's
 * `MethodOrderer.OrderAnnotation` says): a method may sit anywhere in the source, so the order is read, not the position.
 */
function javaTests(contract: string): { method: string; order: string }[] {
  const source = readFileSync(join(CONTRACTS, `${contract}.java`), "utf8");
  return [...source.matchAll(/@Test\s+@Order\(([^)]+)\)\s+default void (\w+)\(\)/g)]
    .map((match) => ({ order: (match[1] as string).trim(), method: match[2] as string }))
    .sort((a, b) => orderValue(a.order) - orderValue(b.order));
}

// Every capability, with the Java contract each one ports (the oracle for ids, order and titles).
const PORTED: Record<string, { contract: string; prefix: string }> = {
  submissions: { contract: "SubmissionsContract", prefix: "SUB" },
  "submissions-test": { contract: "SubmissionsDryRunContract", prefix: "DRY" },
  forms: { contract: "FormsContract", prefix: "FRM" },
  assets: { contract: "AssetsContract", prefix: "AST" },
  builder: { contract: "BuilderContract", prefix: "BLD" },
  pdf: { contract: "PdfContract", prefix: "PDF" },
  tsa: { contract: "TsaContract", prefix: "TSA" },
  passkeys: { contract: "PasskeysContract", prefix: "PKY" },
  hardening: { contract: "HardeningContract", prefix: "HRD" },
  "runtime-down": { contract: "RuntimeDownContract", prefix: "RDN" },
  "host-context": { contract: "HostContextContract", prefix: "HCX" },
  flood: { contract: "FloodContract", prefix: "FLD" }
};

describe("the case catalogue", () => {
  it("has one module per capability, in the fixed run order with flood last", () => {
    expect(MODULES.map((module) => module.capability)).toEqual([...CAPABILITY_ORDER]);
    expect(CAPABILITY_ORDER.at(-1)).toBe("flood");
  });

  it("numbers each capability's cases from 01 in their Java @Order, ids unique", () => {
    const ids = CASES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [capability, { prefix }] of Object.entries(PORTED)) {
      const own = CASES.filter((entry) => entry.capability === capability);
      expect(own.map((entry) => entry.id)).toEqual(own.map((_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`));
      expect([...own].sort((a, b) => a.order - b.order)).toEqual(own);
    }
    expect(ids.filter((id) => /^(SUB|DRY|FRM|AST|BLD|PDF|FLD)-/.test(id))).toEqual([
      "SUB-01", "SUB-02", "SUB-03", "SUB-04", "SUB-05", "SUB-06", "SUB-07", "DRY-01", "DRY-02", "DRY-03", "FRM-01", "FRM-02", "FRM-03", "FRM-04", "AST-01", "AST-02", "AST-03", "AST-04", "AST-05",
      "BLD-01", "BLD-02", "BLD-03", "BLD-04", "PDF-01", "PDF-02", "PDF-03", "PDF-04", "PDF-05", "PDF-06", "FLD-01", "FLD-02"
    ]);
  });

  for (const [capability, { contract }] of Object.entries(PORTED)) {
    it.skipIf(!existsSync(join(CONTRACTS, `${contract}.java`)))(`ports ${contract} one for one: every @Test, its @Order, its name`, () => {
      const java = javaTests(contract);
      const own = CASES.filter((entry) => entry.capability === capability);
      expect(java.length).toBeGreaterThan(0);
      expect(own.map((entry) => entry.oracle)).toEqual(java.map((test) => `${contract}#${test.method}`));
      expect(own.map((entry) => (entry.order >= 1073741823 ? `Order.DEFAULT + ${entry.order - 1073741823}` : String(entry.order)))).toEqual(java.map((test) => test.order));
      expect(own.map((entry) => entry.title)).toEqual(java.map((test) => titleOf(test.method)));
    });
  }

  it("holds at least one case for every capability (no stub module is left)", () => {
    for (const module of MODULES) {
      expect(module.cases.length, module.capability).toBeGreaterThan(0);
    }
    expect(Object.keys(PORTED).sort()).toEqual(MODULES.map((module) => module.capability).sort());
  });

  it("titles a Java method name as words", () => {
    expect(titleOf("theGoldenValidDocumentIsAcceptedWithADigestAndAReceipt")).toBe("the golden valid document is accepted with a digest and a receipt");
    expect(titleOf("theDefinitionCarriesAnETagThatEarnsA304")).toBe("the definition carries an ETag that earns a 304");
    expect(titleOf("askingTooOftenIs429WithRetryAfter")).toBe("asking too often is 429 with retry after");
    expect(titleOf("aStaleVersionTheWrongTypeAndAHugeBodyAreRefusedBeforeTheKernelIsAsked")).toBe("a stale version the wrong type and a huge body are refused before the kernel is asked");
    expect(titleOf("theCertificatesAreServedInPEMAndDER")).toBe("the certificates are served in PEM and DER");
  });

  it("says for every case what it sends and expects", () => {
    for (const entry of CASES) {
      expect(entry.expects.length, entry.id).toBeGreaterThan(20);
      expect(entry.oracle, entry.id).toMatch(/^[A-Z]\w+Contract#[a-z]\w+$/);
    }
  });
});
