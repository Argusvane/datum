import { createHash } from "node:crypto";

import { compareAbi } from "./runners/program/detect-abi.js";
import type { CustomPredicate } from "./predicates.js";
import { ENDPOINT_CUSTOMS } from "./runners/endpoint/customs.js";
import { BUILDER_CUSTOMS } from "./runners/endpoint/profiles/builder-customs.js";

/**
 * Code-defined predicates a vector names with `{ op: "custom", name }`. Each describes itself,
 * so the report and `explain` can print it.
 */
export const CUSTOM_PREDICATES: Record<string, CustomPredicate> = {
  ...ENDPOINT_CUSTOMS,
  ...BUILDER_CUSTOMS,
  /**
   * DEF: every entry of the answer's problem lists has a short `where` (at most 80 characters) free
   * of control characters and line separators, and no list is longer than the cap plus its marker.
   */
  "problem-lists-bounded": {
    describe: () => "every problem list has at most 201 entries and every where is at most 80 printable characters",
    check: (observation) => {
      if (observation.kind !== "answer" || observation.json === null || typeof observation.json !== "object" || Array.isArray(observation.json)) {
        return { pass: false, reason: `wanted an answer, got ${observation.kind}` };
      }
      const answer = observation.json as Record<string, unknown>;
      for (const name of ["problems", "warnings", "structure", "structureWarnings"]) {
        const list = answer[name];
        if (!Array.isArray(list)) {
          continue;
        }
        if (list.length > 201) {
          return { pass: false, reason: `${name} holds ${list.length} entries, over 201` };
        }
        for (const entry of list) {
          const where = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>)["where"] : undefined;
          if (typeof where === "string" && (where.length > 80 || /[\u0000-\u001f\u007f\u2028\u2029]/.test(where))) {
            return { pass: false, reason: `a ${name} entry has a where of ${where.length} characters${where.length <= 80 ? " holding a control character" : ""}` };
          }
        }
      }
      return { pass: true, reason: "ok" };
    }
  },
  /** A compared series (`compareSteps`): its first and last answers have the same bytes. */
  "series-repeats-identically": {
    describe: () => "the first and last answers of the series are byte-identical",
    check: (observation) => {
      const steps = observation.kind === "answer" && observation.json !== null && typeof observation.json === "object" && !Array.isArray(observation.json) ? (observation.json as { steps?: { bytes: number; sha256: string; kind: string }[] }).steps : undefined;
      if (!Array.isArray(steps) || steps.length < 2) {
        return { pass: false, reason: "the series did not keep its step digests" };
      }
      const first = steps[0] as { bytes: number; sha256: string; kind: string };
      const last = steps[steps.length - 1] as { bytes: number; sha256: string; kind: string };
      if (first.kind !== "answer") {
        return { pass: false, reason: `the first step was a ${first.kind}, not an answer` };
      }
      return first.sha256 === last.sha256 ? { pass: true, reason: `${first.bytes} bytes both times` } : { pass: false, reason: `the same request answered ${first.bytes} bytes, then ${last.bytes} bytes (different SHA-256)` };
    }
  },
  /** Planted `__proto__` / `constructor.prototype` keys did not reach the harness's own prototypes. */
  "no-prototype-pollution": {
    describe: () => "no prototype pollution reached the harness",
    check: () => {
      const probe = {} as Record<string, unknown>;
      const polluted = probe["polluted"] !== undefined || (Object.prototype as unknown as Record<string, unknown>)["polluted"] !== undefined;
      return polluted ? { pass: false, reason: "Object.prototype.polluted is set in the harness" } : { pass: true, reason: "ok" };
    }
  },
  /** The digest is the SHA-256 of the canonical text's UTF-8 bytes, hashed here with node:crypto (not by the program's own code). */
  "digest-is-sha256-of-canonical": {
    describe: () => "digest = SHA-256 of the UTF-8 canonical text (checked with node:crypto)",
    check: (observation) => {
      if (observation.kind !== "verdict" || observation.canonical === undefined || observation.digest === undefined) {
        return { pass: false, reason: "the outcome has no canonical text and digest" };
      }
      const want = createHash("sha256").update(observation.canonical, "utf8").digest("hex");
      return observation.digest === want ? { pass: true, reason: "ok" } : { pass: false, reason: `digest ${observation.digest.slice(0, 12)}... is not the SHA-256 of the canonical text (${want.slice(0, 12)}...)` };
    }
  },
  /** The run came back as a verdict or as a typed refusal of the resource kinds; never a malformed outcome, a server error or an untyped failure. */
  "typed-outcome": {
    describe: () => "ends in a verdict or a typed budget/size refusal (never a malformed outcome or an untyped failure)",
    check: (observation) => {
      if (observation.kind === "verdict") {
        return { pass: true, reason: "verdict" };
      }
      if (observation.kind === "refusal" && ["budget", "too_large", "too_deep", "definition_too_deep"].includes(observation.refusal)) {
        return { pass: true, reason: observation.refusal };
      }
      return { pass: false, reason: observation.kind === "refusal" ? `untyped failure: ${observation.refusal} (${observation.code ?? "no code"}): ${observation.detail.slice(0, 160)}` : `wanted a verdict or a typed refusal, got ${observation.kind}` };
    }
  },
  /** A size/depth refusal that names what it refused (the path and the limit), not a bare failure. */
  "refusal-names-limit": {
    describe: () => "the refusal names the value and the limit it exceeded",
    check: (observation) =>
      observation.kind === "refusal" && /at "[^"]+"/.test(observation.detail) && /\d/.test(observation.detail)
        ? { pass: true, reason: observation.detail.slice(0, 120) }
        : { pass: false, reason: `the refusal does not name a path and a limit: ${observation.kind === "refusal" ? observation.detail.slice(0, 160) : observation.kind}` }
  },
  /** The heap recycler replaced the WASM module during the run (RES-04). */
  "module-recycled": {
    describe: () => "the module's heap passed the recycle threshold and the sandbox was rebuilt over a fresh module",
    check: (observation) =>
      observation.kind === "verdict" && observation.meta?.["moduleRecycled"] === true
        ? { pass: true, reason: "module recycled" }
        : { pass: false, reason: "the WASM module was not replaced after the run grew its heap" }
  },
  /**
   * The detected ABI is of the floor's major and at the floor or above, agrees with the manifest and
   * with the program's own refusal message, and the program refuses the majors either side. A banner
   * that disagrees only warns.
   */
  "abi-detection": {
    describe: () => "detected ABI of the floor's major and >= floor; equals the manifest's sandboxAbi; the majors either side refused; banner agrees (WARN if not)",
    check: (observation) => {
      if (observation.kind !== "answer") {
        return { pass: false, reason: `wanted an answer, got ${observation.kind}` };
      }
      const info = observation.json as {
        detected?: string | null;
        floor?: string;
        manifestAbi?: string | null;
        bannerAbi?: string | null;
        majorBelowRefused?: boolean;
        majorAboveRefused?: boolean;
        messageDisagrees?: boolean;
        problem?: string | null;
      };
      if (typeof info.detected !== "string") {
        return { pass: false, reason: `the program does not answer __datum_inspect${typeof info.problem === "string" ? ` (${info.problem})` : ""}` };
      }
      const floor = info.floor ?? "0.0.0";
      if (info.detected.split(".")[0] !== floor.split(".")[0] || compareAbi(info.detected, floor) < 0) {
        return { pass: false, reason: `the program answers ABI ${info.detected}, not the floor ${floor} or a later version of its major; rebuild it` };
      }
      if (typeof info.manifestAbi === "string" && info.manifestAbi !== info.detected) {
        return { pass: false, reason: `the manifest says sandboxAbi ${info.manifestAbi} but the program answers ${info.detected}` };
      }
      if (info.messageDisagrees === true) {
        return { pass: false, reason: "the program's refusal message names a different ABI than its accept/refuse behaviour" };
      }
      if (info.majorBelowRefused !== true || info.majorAboveRefused !== true) {
        return { pass: false, reason: "the program accepts a request naming another ABI major" };
      }
      if (typeof info.bannerAbi === "string" && info.bannerAbi !== info.detected) {
        return { pass: true, warn: true, reason: `the banner comment says ABI ${info.bannerAbi} but the program answers ${info.detected}` };
      }
      return { pass: true, reason: `ABI ${info.detected}` };
    }
  }
};
