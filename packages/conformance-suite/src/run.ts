import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { WASM_ABI_VERSION } from "@argusvane/datum-engine";

import { BUNDLED_GOLDEN, chooseGolden, type GoldenFile } from "./fixtures/golden.js";
import { redactArgv } from "./report/json.js";
import { decideVerdict, summarize, type Report, type RunnerName, type VectorResult } from "./report/model.js";
import type { Divergence } from "./runners/parity/divergences.js";
import { runParityVectors } from "./runners/parity/parity-runner.js";
import { ProgramRunner, type BudgetProfile } from "./runners/program/program-runner.js";
import { programFromText, type LoadedProgram } from "./runners/program/load-program.js";
import type { QjsWasiModule } from "./runners/program/qjs-wasi.js";
import { SUITE_NAME, SUITE_VERSION, VECTOR_SET_ID, DEFAULT_ABI_FLOOR } from "./version.js";
import { VECTORS, matchesSelector } from "./vectors/index.js";
import type { PluginSource, Vector } from "./vectors/schema.js";

export interface RunSuiteOptions {
  /** The program under test (see {@link loadProgram}, {@link programFromText}). */
  program: LoadedProgram;
  abiFloor?: string;
  budgetProfile?: BudgetProfile;
  /** The ABI the manifest next to the program names (`sandboxAbi`). */
  manifestAbi?: string;
  /** A golden file overriding the bundled ones. */
  golden?: GoldenFile;
  plugins?: PluginSource[];
  only?: string[];
  skip?: string[];
  gate?: "release" | "full";
  failOn?: "fail" | "warn";
  heavy?: boolean;
  /** False runs without the host's freeze of the kernel and the intrinsics (tests: the negative control for ISO-04). */
  freezeIntrinsics?: boolean;
  /** Which runners to run; program only when left out. `parity` compares the in-process kernel with the program (PAR vectors). */
  modes?: ("program" | "parity")[];
  /** The parity divergence ledger (tests); the built-in one when left out. */
  ledger?: readonly Divergence[];
  argv?: string[];
  /** Replaces the catalogue (tests). */
  vectors?: readonly Vector[];
  /** Called as each vector finishes. */
  onResult?: (result: VectorResult) => void;
  /**
   * The server hosts' engine: `qjs-wasi.wasm` (quickjs-ng), checked against its pin ({@link loadQjsWasiModule}), on which
   * the program and parity modes run the program instead of quickjs-emscripten (Bellard QuickJS, the engine of the
   * browser and Node hosts).
   */
  engine?: QjsWasiModule;
}

/** Which vectors a `--only` / `--skip` pair selects, in catalogue order. */
export function selectVectors(vectors: readonly Vector[], only: readonly string[] = [], skip: readonly string[] = []): Vector[] {
  return vectors.filter((vector) => {
    if (only.length > 0 && !only.some((selector) => matchesSelector(vector, selector))) {
      return false;
    }
    return !skip.some((selector) => matchesSelector(vector, selector));
  });
}

/** Runs program mode: the vectors that apply to a program file, against it. Returns the report. */
export async function runSuite(options: RunSuiteOptions): Promise<Report> {
  const startedAt = new Date();
  const started = performance.now();
  const gate = options.gate ?? "release";
  const abiFloor = options.abiFloor ?? DEFAULT_ABI_FLOOR;
  const budgetProfile = options.budgetProfile ?? "node";
  const catalogue = options.vectors ?? VECTORS;

  // The golden file's note follows the program's own ABI, so it is set after detection.
  const runner = new ProgramRunner(
    {
      program: options.program,
      abiFloor,
      budgetProfile,
      ...(options.manifestAbi !== undefined ? { manifestAbi: options.manifestAbi } : {}),
      ...(options.plugins !== undefined ? { plugins: options.plugins } : {}),
      heavy: options.heavy === true || gate === "full",
      ...(options.freezeIntrinsics === false ? { freezeIntrinsics: false } : {}),
      ...(options.engine !== undefined ? { engine: options.engine } : {}),
      gate
    },
    options.golden !== undefined ? { golden: options.golden, file: "custom" } : chooseGolden(undefined)
  );
  const prepared = await runner.prepare();
  if (options.golden === undefined) {
    runner.useGolden(chooseGolden(prepared.detection?.detected));
  }

  const modes = options.modes ?? ["program"];
  const results: VectorResult[] = [];
  for (const vector of modes.includes("program") ? selectVectors(catalogue, options.only, options.skip) : []) {
    if (vector.applies.program === false) {
      continue;
    }
    let result: VectorResult;
    const vectorGate = vector.gate;
    if (vectorGate.status === "pending" && gate === "release") {
      result = {
        id: vector.id,
        title: vector.title,
        class: vector.class,
        severity: vector.severity,
        attacker: vector.attacker,
        runner: "program",
        status: "SKIP",
        gate: "pending",
        blockedBy: vectorGate.blockedBy,
        expected: "",
        observed: null,
        durationMs: 0,
        limitMs: null,
        notes: `pending (blocked by ${vectorGate.blockedBy}); run with --gate full`
      };
    } else {
      result = await runner.runVector(vector);
    }
    results.push(result);
    options.onResult?.(result);
  }

  let parityReport: Report["parity"];
  if (modes.includes("parity")) {
    const parity = await runParityVectors({
      program: options.program,
      golden: options.golden ?? chooseGolden(prepared.detection?.detected).golden,
      vectors: catalogue,
      ...(options.ledger !== undefined ? { ledger: options.ledger } : {}),
      gate,
      heavy: options.heavy === true || gate === "full",
      ...(options.only !== undefined ? { only: options.only } : {}),
      ...(options.skip !== undefined ? { skip: options.skip } : {}),
      ...(options.onResult !== undefined ? { onResult: options.onResult } : {}),
      ...(options.engine !== undefined ? { engine: options.engine } : {})
    });
    results.push(...parity.results);
    parityReport = parity.report;
  }

  const programReport = runner.programReport();
  const finishedAt = new Date();
  const decision = decideVerdict(results, {
    failOn: options.failOn ?? "fail",
    inconclusive: programReport.startupError !== null ? [`the program did not start: ${programReport.startupError}`] : []
  });
  return {
    schemaVersion: 1,
    suite: { name: SUITE_NAME, version: SUITE_VERSION, vectorSet: VECTOR_SET_ID, vectorCount: catalogue.length },
    run: {
      id: randomUUID(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.round(performance.now() - started),
      modes: modes satisfies RunnerName[],
      gate,
      argv: redactArgv(options.argv ?? [])
    },
    environment: environment(options.engine),
    program: programReport,
    ...(parityReport !== undefined ? { parity: parityReport } : {}),
    summary: summarize(results),
    verdict: decision.verdict,
    reasons: decision.reasons,
    results
  };
}

/** The environment block of a report (node, platform, engine ABI, commit, and the JavaScript engine the program ran on). */
export function environment(qjsWasi?: QjsWasiModule): Report["environment"] {
  return {
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    ci: process.env["CI"] !== undefined && process.env["CI"] !== "" && process.env["CI"] !== "false",
    engine: { abi: WASM_ABI_VERSION, commit: gitCommit() },
    quickjs:
      qjsWasi !== undefined
        ? { package: `qjs-wasi.wasm (quickjs-ng) sha256:${qjsWasi.sha256}`, variant: "node:wasi, one guest per call" }
        : { package: "quickjs-emscripten-core@0.32.0", variant: "singlefile-mjs-release-sync" }
  };
}

function gitCommit(): string | null {
  const fromEnv = process.env["GITHUB_SHA"];
  if (fromEnv !== undefined && /^[0-9a-f]{7,40}$/.test(fromEnv)) {
    return fromEnv;
  }
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** Reads `sandboxAbi` out of a host's assets manifest. */
export function readManifestAbi(path: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read the manifest ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const abi = (parsed as { sandboxAbi?: unknown } | null)?.sandboxAbi;
  if (typeof abi !== "string") {
    throw new Error(`the manifest ${path} has no sandboxAbi`);
  }
  return abi;
}

export { BUNDLED_GOLDEN, programFromText };
