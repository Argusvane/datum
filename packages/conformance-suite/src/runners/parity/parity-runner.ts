import {
  adversarialValueVectors,
  coreValidationVectors,
  InProcessWasmHostAdapter,
  JsonWasmAbi,
  runParity,
  WasmValidationHost,
  type ParityMismatch
} from "@argusvane/datum-engine";

import type { GoldenFile } from "../../fixtures/golden.js";
import { resolveGenerators } from "../../fixtures/builders.js";
import { statusFor } from "../../judge.js";
import type { Json, Observation } from "../../observation.js";
import type { ParityReport, ResultStatus, VectorResult } from "../../report/model.js";
import { matchesSelector } from "../../vectors/index.js";
import type { Fixture, Vector, VectorInput } from "../../vectors/schema.js";
import type { LoadedProgram } from "../program/load-program.js";
import { ProgramSession } from "../program/session.js";
import { openParityAdapters } from "./adapters.js";
import { compareBytes } from "./compare.js";
import { contextFor } from "./context.js";
import { digestParity } from "./digest.js";
import { DIVERGENCES, settleAgainstLedger, type Divergence, type LedgerOutcome } from "./divergences.js";
import { FUNCTION_CASES, FUNCTION_TODAY } from "./functions.js";

export interface ParityRunOptions {
  program: LoadedProgram;
  golden: GoldenFile;
  /** The catalogue whose `PAR` vectors run and whose `applies.parity` vectors feed PAR-03. */
  vectors: readonly Vector[];
  ledger?: readonly Divergence[];
  gate?: "release" | "full";
  /** Run the heavy vectors in the PAR-03 corpus too. */
  heavy?: boolean;
  only?: readonly string[];
  skip?: readonly string[];
  now?: Date;
  onResult?: (result: VectorResult) => void;
}

export interface ParityRunOutput {
  results: VectorResult[];
  report: ParityReport;
}

const FAILED = "!failed";

/** What one side said about one wire context: the outcome text, or {@link FAILED} when it threw or refused. */
interface Said {
  text: string;
  why?: string;
}

/** PAR-03's corpus: the vectors that opted into parity, each as one row per base input and variant. */
export interface CorpusRow {
  key: string;
  fixture: Fixture;
  input: VectorInput;
}

/**
 * Lets the event loop turn between two synchronous program runs. The sync host runs a vector
 * inside one QuickJS call, and an `await` on its already-settled promise never leaves the
 * microtask queue: a table of a few hundred vectors is one unbroken block to the process,
 * during which no message is read and no timer fires. Under vitest that block is the
 * worker's, and its calls to the main process (`onTaskUpdate`) time out at 60 s once the
 * loop is back, which a loaded two-core CI runner reaches. A
 * `setImmediate` turn is a macrotask: the messages and timers are served, at no cost worth
 * measuring beside the run.
 */
export function breathe(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function corpusRows(vectors: readonly Vector[], heavy: boolean): { rows: CorpusRow[]; skipped: string[] } {
  const rows: CorpusRow[] = [];
  const skipped: string[] = [];
  for (const vector of vectors) {
    const applies = vector.applies.parity;
    if (vector.class === "parity" || applies === false) {
      continue;
    }
    if (applies.heavy === true && !heavy) {
      skipped.push(`${vector.id}: heavy`);
      continue;
    }
    const candidates = [
      { key: vector.id, fixture: vector.fixture, input: vector.input },
      ...(vector.variants ?? []).map((variant) => ({
        key: `${vector.id}#${variant.id}`,
        fixture: { ...vector.fixture, ...variant.fixture } as Fixture,
        input: variant.input ?? vector.input
      }))
    ];
    for (const candidate of candidates) {
      if (candidate.input.kind !== "values" && candidate.input.kind !== "raw") {
        skipped.push(`${candidate.key}: ${candidate.input.kind} input`);
      } else if ((candidate.fixture.plugins ?? []).length > 0) {
        skipped.push(`${candidate.key}: plugin source (the in-process kernel never evaluates source)`);
      } else if (candidate.fixture.hostOptions !== undefined) {
        skipped.push(`${candidate.key}: host limits (the kernel has none)`);
      } else {
        rows.push(candidate);
      }
    }
  }
  return { rows, skipped };
}

function wireFor(abi: JsonWasmAbi, row: CorpusRow): string {
  if (row.input.kind === "raw") {
    return typeof row.input.body === "string" ? row.input.body : String(resolveGenerators(row.input.body));
  }
  return abi.serializeContext(contextFor(row.fixture, row.input as Extract<VectorInput, { kind: "values" }>) as never, WasmValidationHost.STRICT_POLICY);
}

/** The in-process kernel's outcome bytes for a wire context. */
async function kernelSays(abi: JsonWasmAbi, wire: string): Promise<Said> {
  try {
    return { text: await new InProcessWasmHostAdapter().instantiate([], abi).run(wire) };
  } catch (error) {
    return { text: FAILED, why: error instanceof Error ? error.message : String(error) };
  }
}

async function programSays(program: LoadedProgram, wire: string): Promise<Said> {
  let session: ProgramSession;
  try {
    session = await ProgramSession.open({ program: program.text });
  } catch (error) {
    return { text: FAILED, why: error instanceof Error ? error.message : String(error) };
  }
  try {
    const run = await session.run(wire);
    if (run.text !== undefined) {
      return { text: run.text };
    }
    return { text: FAILED, why: run.observation.kind === "refusal" ? `${run.observation.refusal}: ${run.observation.detail}` : run.observation.kind };
  } finally {
    session.dispose();
  }
}

/** Runs one comparison table of `key -> [kernel, program]` outcomes and names the keys that differ. */
function differences(table: { key: string; kernel: Said; program: Said }[]): { differing: string[]; notes: string[] } {
  const differing: string[] = [];
  const notes: string[] = [];
  for (const row of table) {
    const compared = compareBytes(row.kernel.text, row.program.text);
    if (!compared.equal) {
      differing.push(row.key);
      notes.push(
        compared.excerpts === undefined
          ? `${row.key}: differs`
          : `${row.key}: first difference at ${compared.firstDifference} (${compared.lengths[0]} vs ${compared.lengths[1]} chars): kernel ...${compared.excerpts[0]}... program ...${compared.excerpts[1]}...` +
              (row.kernel.why !== undefined || row.program.why !== undefined ? ` [${row.kernel.why ?? ""} / ${row.program.why ?? ""}]` : "")
      );
    }
  }
  return { differing, notes };
}

function answer(json: Json): Observation {
  return { kind: "answer", json };
}

/** Runs every selected `PAR` vector. PAR-06 (endpoint projection) stays pending on the endpoint runner. */
export async function runParityVectors(options: ParityRunOptions): Promise<ParityRunOutput> {
  const ledger = options.ledger ?? DIVERGENCES;
  const gate = options.gate ?? "release";
  const now = options.now ?? new Date();
  const selected = options.vectors.filter(
    (vector) =>
      vector.class === "parity" &&
      (options.only === undefined || options.only.length === 0 || options.only.some((selector) => matchesSelector(vector, selector))) &&
      !(options.skip ?? []).some((selector) => matchesSelector(vector, selector))
  );
  const results: VectorResult[] = [];
  const declaredAll: ParityReport["divergences"] = [];
  const corpus = { core: coreValidationVectors.length, adversarial: adversarialValueVectors.length, suite: 0 };

  const base = (vector: Vector) => ({
    id: vector.id,
    title: vector.title,
    class: vector.class,
    severity: vector.severity,
    attacker: vector.attacker,
    runner: "parity" as const,
    gate: vector.gate.status,
    blockedBy: vector.gate.status === "pending" ? vector.gate.blockedBy : null,
    limitMs: null
  });

  const settle = (vector: Vector, started: number, outcome: LedgerOutcome, checked: number, expected: string, extra: Record<string, Json> = {}, notes: string[] = []): VectorResult => {
    const status: ResultStatus = statusFor({ pass: outcome.undeclared.length === 0, warn: outcome.stale.length > 0 }, vector.gate);
    for (const { entry } of outcome.declared) {
      declaredAll.push({ vector: entry.vector, reason: entry.reason, stale: false });
    }
    for (const { entry } of outcome.stale) {
      declaredAll.push({ vector: entry.vector, reason: entry.reason, stale: true });
    }
    const declaredText = outcome.declared.map(({ key, entry }) => `${key}: ${entry.reason}`);
    const staleText = outcome.stale.map(({ entry, why }) => `${entry.vector} ${why}`);
    const allNotes = [
      ...(outcome.undeclared.length > 0 ? [`undeclared: ${outcome.undeclared.join(", ")}`] : []),
      ...(declaredText.length > 0 ? [`declared: ${declaredText.join("; ")}`] : []),
      ...(staleText.length > 0 ? [`stale ledger: ${staleText.join("; ")}`] : []),
      ...notes
    ];
    return {
      ...base(vector),
      status,
      expected,
      observed: answer({ checked, undeclared: outcome.undeclared, declared: declaredText, stale: staleText, ...extra }),
      durationMs: performance.now() - started,
      ...(allNotes.length > 0 ? { notes: allNotes.join(" | ") } : {})
    };
  };

  const emit = (result: VectorResult): void => {
    results.push(result);
    options.onResult?.(result);
  };

  const failed = (vector: Vector, started: number, error: unknown): VectorResult => ({
    ...base(vector),
    status: "ERROR",
    expected: "",
    observed: null,
    durationMs: performance.now() - started,
    notes: `the parity run could not complete: ${error instanceof Error ? error.message : String(error)}`
  });

  for (const vector of selected) {
    const started = performance.now();
    if (vector.gate.status === "pending" && gate === "release") {
      emit({ ...base(vector), status: "SKIP", expected: "", observed: null, durationMs: 0, notes: `pending (blocked by ${vector.gate.blockedBy}); run with --gate full` });
      continue;
    }
    try {
      switch (vector.id) {
        case "PAR-01":
        case "PAR-02": {
          const { adapters, dispose } = await openParityAdapters(options.program.text);
          try {
            const corpusVectors = vector.id === "PAR-01" ? coreValidationVectors : adversarialValueVectors;
            // Each adapter breathes before its run: the engine's runParity awaits the adapters in turn and nothing else.
            const breathing = adapters.map((adapter) => ({
              ...adapter,
              run: async (context: Parameters<typeof adapter.run>[0]) => {
                await breathe();
                return adapter.run(context);
              }
            }));
            const report = await runParity(corpusVectors, breathing);
            const differing = report.mismatches.map((mismatch: ParityMismatch) => mismatch.vectorId);
            const outcome = settleAgainstLedger(vector.id, "kernel-program", corpusVectors.map((entry) => entry.id), differing, ledger, now);
            emit(
              settle(vector, started, outcome, report.checked, "kernel and program give identical normalised error signatures", {}, report.mismatches.map((mismatch) => `${mismatch.vectorId}: ${JSON.stringify(mismatch.signatures)}`))
            );
          } finally {
            dispose();
          }
          break;
        }
        case "PAR-03": {
          const { rows, skipped } = corpusRows(options.vectors, options.heavy === true || gate === "full");
          corpus.suite = rows.length;
          const abi = new JsonWasmAbi();
          const table: { key: string; kernel: Said; program: Said }[] = [];
          for (const row of rows) {
            await breathe();
            const wire = wireFor(abi, row);
            table.push({ key: row.key, kernel: await kernelSays(abi, wire), program: await programSays(options.program, wire) });
          }
          const diff = differences(table);
          const outcome = settleAgainstLedger(vector.id, "kernel-program", rows.map((row) => row.key), diff.differing, ledger, now);
          emit(settle(vector, started, outcome, rows.length, "kernel and program give byte-identical outcomes", { skipped }, diff.notes));
          break;
        }
        case "PAR-04": {
          const abi = new JsonWasmAbi();
          const table: { key: string; kernel: Said; program: Said }[] = [];
          const wrong: string[] = [];
          for (const entry of FUNCTION_CASES) {
            await breathe();
            const root = { id: "form", type: "form", configuration: { formulaErrors: "fail" }, children: { content: [{ id: "r", type: entry.kind, configuration: {}, rules: { value: entry.formula } }] } };
            const wire = abi.serializeContext({ formId: "parity-functions", values: {}, locale: "en", today: FUNCTION_TODAY, form: root } as never, WasmValidationHost.STRICT_POLICY);
            const kernel = await kernelSays(abi, wire);
            const program = await programSays(options.program, wire);
            table.push({ key: entry.id, kernel, program });
            for (const [side, said] of [["kernel", kernel], ["program", program]] as const) {
              const value = said.text === FAILED ? undefined : (JSON.parse(said.text) as { values?: { r?: unknown } }).values?.r;
              if (value !== entry.expected) {
                wrong.push(`${entry.id}: ${side} says ${JSON.stringify(value)}, expected ${JSON.stringify(entry.expected)}`);
              }
            }
          }
          const diff = differences(table);
          const outcome = settleAgainstLedger(vector.id, "kernel-program", FUNCTION_CASES.map((entry) => entry.id), diff.differing, ledger, now);
          // Both engines agreeing on a wrong value is a failure of the pinned expectation, never excused by the ledger.
          for (const line of wrong) {
            outcome.undeclared.push(line);
          }
          emit(settle(vector, started, outcome, FUNCTION_CASES.length, "kernel and program give the same, pinned value for every curated call", {}, diff.notes));
          break;
        }
        case "PAR-05": {
          const session = await ProgramSession.open({ program: options.program.text });
          try {
            const rows = await digestParity(options.golden, session);
            const differing = rows.filter((row) => row.disagree.length > 0).map((row) => row.name);
            const outcome = settleAgainstLedger(vector.id, "kernel-program", rows.map((row) => row.name), differing, ledger, now);
            emit(
              settle(vector, started, outcome, rows.length, "golden, reference, kernel, submissions and program agree on canonical text and digest", {}, rows.filter((row) => row.disagree.length > 0).map((row) => `${row.name}: ${row.disagree.join(", ")} disagree with the golden file`))
            );
          } finally {
            session.dispose();
          }
          break;
        }
        default:
          // PAR-06 and anything a later stage adds: reported honestly, not guessed at.
          emit({ ...base(vector), status: vector.gate.status === "pending" ? "XFAIL" : "SKIP", expected: "", observed: null, durationMs: 0, notes: "needs the endpoint runner" });
      }
    } catch (error) {
      emit(failed(vector, started, error));
    }
  }

  return { results, report: { adapters: ["kernel", "program"], corpus, divergences: declaredAll } };
}
