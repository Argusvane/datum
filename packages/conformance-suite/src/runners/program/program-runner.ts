import { createHash } from "node:crypto";

import { compactObservation } from "../../compact.js";
import { buildRoot, resolveGenerators } from "../../fixtures/builders.js";
import { baseTypes, resolveDefinitionText } from "../../fixtures/definitions.js";
import { BASE_FORM_ID } from "../../fixtures/base-form.js";
import type { GoldenFile } from "../../fixtures/golden.js";
import { CUSTOM_PREDICATES } from "../../customs.js";
import { judge, statusFor } from "../../judge.js";
import type { Json, Observation } from "../../observation.js";
import type { PredicateEnv } from "../../predicates.js";
import { describe as describeExpectation } from "../../predicates.js";
import type { ProgramReport, ResultStatus, VariantResult, VectorResult } from "../../report/model.js";
import type { Fixture, PluginSource, Vector, VectorInput } from "../../vectors/schema.js";
import { detectAbi, type AbiDetection } from "./detect-abi.js";
import type { LoadedProgram } from "./load-program.js";
import type { QjsWasiModule } from "./qjs-wasi.js";
import { QJS_WASI_BUDGET_MS } from "./qjs-wasi-host.js";
import { loadWorkerModule, ProgramSession, StartupError, type RunOutput } from "./session.js";

export type BudgetProfile = "node" | "browser";

/** The nominal evaluation budget of each profile; both use the adapter's scaled default (250 ms and up). */
const PROFILE_BUDGET_MS: Record<BudgetProfile, number> = { node: 250, browser: 250 };

/** A vector without its own bound still ends within this (the interrupt handler enforces the real one). */
export const CEILING_MS = 30_000;

export interface ProgramRunConfig {
  program: LoadedProgram;
  abiFloor: string;
  budgetProfile: BudgetProfile;
  manifestAbi?: string;
  /** Operator plugin modules (`--plugins`), registered beside each vector's own. */
  plugins?: PluginSource[];
  heavy?: boolean;
  /** False opens every sandbox without the host's freeze of the kernel and the intrinsics: the negative control for ISO-04 (tests only). */
  freezeIntrinsics?: boolean;
  /** `release` skips the rows that are still pending (a variant with its own pending gate); `full` (or left out) runs them. */
  gate?: "release" | "full";
  /** The server hosts' engine (`qjs-wasi.wasm`, checked against its pin) instead of quickjs-emscripten. */
  engine?: QjsWasiModule;
}

/** The status of a vector whose rows were judged under different gates: a failure anywhere counts, then what is still pending, then warnings and promotions. */
function combineStatuses(statuses: ResultStatus[]): ResultStatus {
  for (const wanted of ["FAIL", "ERROR", "XFAIL", "WARN", "XPASS"] as const) {
    if (statuses.includes(wanted)) {
      return wanted;
    }
  }
  return "PASS";
}

/**
 * Runs vectors against one program file. A fresh sandbox per vector (and per variant) unless the
 * vector is a series; the first sandbox of a run also tells the program's ABI, which every later
 * vector may refer to (`$detected`, `$nextMinor`).
 */
export class ProgramRunner {
  private detection: AbiDetection | undefined;
  private startupError: string | undefined;
  private golden: GoldenFile;
  private goldenFile: string;
  private goldenNote: string | undefined;

  constructor(private readonly config: ProgramRunConfig, golden: { golden: GoldenFile; file: string; warning?: string }) {
    this.golden = golden.golden;
    this.goldenFile = golden.file;
    this.goldenNote = golden.warning;
  }

  /** Swaps the golden file (after detection says which ABI the program speaks). */
  public useGolden(golden: { golden: GoldenFile; file: string; warning?: string }): void {
    this.golden = golden.golden;
    this.goldenFile = golden.file;
    this.goldenNote = golden.warning;
  }

  /** Starts the program once with no plugins and detects its ABI. A program that will not start is reported, not thrown. */
  public async prepare(): Promise<{ startupError: string | null; detection: AbiDetection | undefined }> {
    let session: ProgramSession;
    try {
      session = await this.open({});
    } catch (error) {
      this.startupError = error instanceof Error ? error.message : String(error);
      return { startupError: this.startupError, detection: undefined };
    }
    try {
      this.detection = await detectAbi(session);
    } finally {
      session.dispose();
    }
    return { startupError: null, detection: this.detection };
  }

  public get detectedAbi(): string | undefined {
    return this.detection?.detected;
  }

  /** The program section of the report. */
  public programReport(): ProgramReport {
    const { program } = this.config;
    const detected = this.detection?.detected;
    return {
      source: program.source,
      path: program.path,
      bytes: program.bytes,
      sha256: program.sha256,
      bannerAbi: program.bannerAbi ?? null,
      detectedAbi: detected ?? null,
      abiFloor: this.config.abiFloor,
      abiOk: detected !== undefined && detected.split(".")[0] === this.config.abiFloor.split(".")[0] && abiAtLeast(detected, this.config.abiFloor),
      manifestAbi: this.config.manifestAbi ?? null,
      budgetProfile: this.config.budgetProfile,
      golden: { file: `abi-${this.goldenFile}.json`, abi: this.golden.abi, ...(this.goldenNote !== undefined ? { note: this.goldenNote } : {}) },
      startupError: this.startupError ?? null
    };
  }

  public async runVector(vector: Vector): Promise<VectorResult> {
    const applies = vector.applies.program;
    const base = {
      id: vector.id,
      title: vector.title,
      class: vector.class,
      severity: vector.severity,
      attacker: vector.attacker,
      runner: "program" as const,
      gate: vector.gate.status,
      blockedBy: vector.gate.status === "pending" ? vector.gate.blockedBy : null,
      ...(vector.hostSensitive === true ? { hostSensitive: true } : {})
    };
    const expectedText = describeExpectation(vector.expect, CUSTOM_PREDICATES);
    if (applies === false) {
      return { ...base, status: "SKIP", expected: expectedText, observed: null, durationMs: 0, limitMs: null, notes: "does not apply to a program file" };
    }
    if (applies.heavy === true && this.config.heavy !== true) {
      return { ...base, status: "SKIP", expected: expectedText, observed: null, durationMs: 0, limitMs: null, notes: "heavy vector; run with --heavy or --gate full" };
    }
    if (this.startupError !== undefined && vector.class !== "abi") {
      return { ...base, status: "ERROR", expected: expectedText, observed: null, durationMs: 0, limitMs: null, notes: `the program did not start: ${this.startupError}` };
    }
    const vectorGate = vector.gate;
    const rows = [
      { id: "(base)", fixture: vector.fixture, input: vector.input, expect: applies.expect ?? vector.expect, gate: vectorGate },
      ...(vector.variants ?? []).map((variant) => ({
        id: variant.id,
        fixture: { ...vector.fixture, ...variant.fixture } as Fixture,
        input: variant.input ?? vector.input,
        expect: variant.expect ?? applies.expect ?? vector.expect,
        gate: variant.gate ?? vector.gate
      }))
    ];
    // Under qjs-wasi every call is a guest of its own, with its own clock: no row needs the worker host.
    if (this.config.engine === undefined && rows.some((row) => row.fixture.host === "worker") && (await loadWorkerModule()) === undefined) {
      return { ...base, status: "SKIP", expected: expectedText, observed: null, durationMs: 0, limitMs: null, notes: "needs the Node worker host (@argusvane/datum-quickjs-wasm-host/worker), which this build cannot reach (the bundled command line keeps it external); run from the repository with npm run check:source" };
    }
    const started = performance.now();
    const variants: VariantResult[] = [];
    let first: { observation: Observation | null; elapsedMs: number; limitMs: number | null } | undefined;
    const failures: string[] = [];
    const rowStatuses: ResultStatus[] = [];
    const skippedRows: string[] = [];
    for (const row of rows) {
      // A row of its own that is still pending is not run in a release check (the vector-level case is skipped by the caller).
      if (this.config.gate === "release" && row.gate.status === "pending" && row.id !== "(base)") {
        skippedRows.push(`${row.id}: pending (blocked by ${row.gate.blockedBy}); run with --gate full`);
        continue;
      }
      // The heap recycler is the quickjs-emscripten host's: under qjs-wasi no module outlives its call, so there is nothing to recycle.
      if (this.config.engine !== undefined && row.fixture.hostOptions?.recycleHeapBytes !== undefined) {
        skippedRows.push(`${row.id}: the heap recycler belongs to the quickjs-emscripten host; under qjs-wasi every call runs in a fresh instance`);
        continue;
      }
      const outcome = await this.runRow(vector, row.fixture, row.input);
      const limitMs = this.limitFor(vector, row.fixture);
      const env: PredicateEnv = {
        elapsedMs: outcome.elapsedMs,
        golden: this.golden,
        customs: CUSTOM_PREDICATES
      };
      // A vector without a bound of its own still ends within the absolute ceiling.
      const judgement = judge(row.expect, outcome.observation, env, limitMs ?? CEILING_MS);
      if (first === undefined) {
        first = { observation: outcome.observation, elapsedMs: outcome.elapsedMs, limitMs };
      }
      const rowStatus = statusFor(judgement, row.gate);
      rowStatuses.push(rowStatus);
      if (!judgement.pass) {
        failures.push(`${row.id}: ${judgement.reason}`);
      } else if (judgement.warn) {
        failures.push(`${row.id}: ${judgement.reason}`);
      }
      if (rows.length > 1 && row.id !== "(base)") {
        variants.push({
          id: row.id,
          status: rowStatus,
          expected: describeExpectation(row.expect, CUSTOM_PREDICATES),
          observed: compactObservation(outcome.observation),
          ...(judgement.pass && !judgement.warn ? {} : { notes: judgement.reason })
        });
      }
    }
    if (rowStatuses.length === 0) {
      return { ...base, status: "SKIP", expected: expectedText, observed: null, durationMs: 0, limitMs: null, notes: skippedRows.join("; ") };
    }
    const status = combineStatuses(rowStatuses);
    return {
      ...base,
      gate: vectorGate.status,
      blockedBy: vectorGate.status === "pending" ? vectorGate.blockedBy : null,
      status,
      expected: expectedText,
      observed: compactObservation(first?.observation ?? null),
      durationMs: performance.now() - started,
      limitMs: first?.limitMs ?? null,
      ...(variants.length > 0 ? { variants } : {}),
      ...(failures.length > 0 || skippedRows.length > 0 ? { notes: [...failures, ...skippedRows].join(" | ") } : {})
    };
  }

  private limitFor(vector: Vector, fixture: Fixture): number | null {
    if (vector.limits.programMs !== undefined) {
      return vector.limits.programMs;
    }
    if (vector.limits.programBudgetMultiple !== undefined) {
      const budget = this.nodeBudget(vector) ?? fixture.hostOptions?.maxEvalMs ?? (this.config.engine !== undefined ? QJS_WASI_BUDGET_MS : PROFILE_BUDGET_MS[this.config.budgetProfile]);
      return vector.limits.programBudgetMultiple * budget;
    }
    return null;
  }

  /** The vector's allowance for a slow Node host; under qjs-wasi the server hosts' default budget is already above it. */
  private nodeBudget(vector: Vector): number | undefined {
    return this.config.engine !== undefined ? undefined : vector.limits.nodeBudgetMs;
  }

  private async open(fixture: Pick<Fixture, "plugins" | "hostOptions" | "host">): Promise<ProgramSession> {
    const maxEvalMs = fixture.hostOptions?.maxEvalMs;
    return ProgramSession.open({
      program: this.config.program.text,
      plugins: [...(this.config.plugins ?? []), ...(fixture.plugins ?? [])],
      ...(fixture.host !== undefined ? { host: fixture.host } : {}),
      ...(this.config.freezeIntrinsics === false ? { freezeIntrinsics: false } : {}),
      ...(maxEvalMs !== undefined ? { maxEvalMs } : {}),
      ...(fixture.hostOptions?.memoryLimitBytes !== undefined ? { memoryLimitBytes: fixture.hostOptions.memoryLimitBytes } : {}),
      ...(fixture.hostOptions?.recycleHeapBytes !== undefined ? { recycleHeapBytes: fixture.hostOptions.recycleHeapBytes } : {}),
      ...(this.config.engine !== undefined ? { engine: this.config.engine } : {})
    });
  }

  /** One row (the vector's base input or a variant) on a fresh sandbox. */
  private async runRow(vector: Vector, fixture: Fixture, input: VectorInput): Promise<{ observation: Observation; elapsedMs: number }> {
    let session: ProgramSession;
    try {
      const nodeBudget = this.nodeBudget(vector);
      session = await this.open(nodeBudget === undefined ? fixture : { ...fixture, hostOptions: { ...fixture.hostOptions, maxEvalMs: nodeBudget } });
    } catch (error) {
      // A plugin that stops the sandbox from starting is an observation (ISO-05 expects it).
      if (error instanceof StartupError) {
        return { observation: { kind: "refusal", refusal: "other", code: error.code, detail: error.message }, elapsedMs: 0 };
      }
      return { observation: { kind: "refusal", refusal: "other", detail: error instanceof Error ? error.message : String(error) }, elapsedMs: 0 };
    }
    try {
      const done = await this.execute(session, vector, fixture, input);
      // The heap recycler replaced the WASM module during this row (RES-04 asks for it).
      if (done.observation.kind === "verdict" && session.moduleSwapped()) {
        done.observation.meta = { ...(done.observation.meta ?? {}), moduleRecycled: true };
      }
      return done;
    } finally {
      session.dispose();
    }
  }

  private async execute(session: ProgramSession, vector: Vector, fixture: Fixture, input: VectorInput): Promise<{ observation: Observation; elapsedMs: number }> {
    switch (input.kind) {
      case "series": {
        let last: RunOutput | undefined;
        let elapsedMs = 0;
        const stepDigests: Json[] = [];
        for (const step of input.steps) {
          const done = await this.execute(session, vector, fixture, step);
          elapsedMs += done.elapsedMs;
          last = { observation: done.observation, elapsedMs: done.elapsedMs };
          if (input.compareSteps === true) {
            const text = done.observation.kind === "answer" ? JSON.stringify(done.observation.json) : JSON.stringify(done.observation);
            stepDigests.push({ bytes: Buffer.byteLength(text, "utf8"), sha256: createHash("sha256").update(text, "utf8").digest("hex"), kind: done.observation.kind });
          }
        }
        if (last === undefined) {
          return { observation: { kind: "refusal", refusal: "other", detail: "a series with no steps" }, elapsedMs: 0 };
        }
        if (input.compareSteps === true) {
          return { observation: { kind: "answer", json: { steps: stepDigests } }, elapsedMs };
        }
        return { observation: last.observation, elapsedMs };
      }
      case "detect-abi": {
        const started = performance.now();
        const detection = this.detection ?? (await detectAbi(session));
        const json: Json = {
          detected: detection.detected ?? null,
          messageAbi: detection.messageAbi ?? null,
          bannerAbi: this.config.program.bannerAbi ?? null,
          manifestAbi: this.config.manifestAbi ?? null,
          floor: this.config.abiFloor,
          majorBelowRefused: detection.majorBelowRefused,
          majorAboveRefused: detection.majorAboveRefused,
          messageDisagrees: detection.messageDisagrees === true,
          problem: detection.problem ?? null
        };
        return { observation: { kind: "answer", json }, elapsedMs: performance.now() - started };
      }
      case "inspect": {
        // Text requests carry a definition as JSON text (a `__proto__` key and duplicate keys survive); objects are serialized here.
        const text = input.requestText !== undefined ? this.fillRequestText(input.requestText, fixture) : JSON.stringify(this.substituteTokens(resolveGenerators(input.request as Json)));
        const output = await session.inspect(text);
        return { observation: output.observation, elapsedMs: output.elapsedMs };
      }
      case "raw": {
        const body = typeof input.body === "string" ? input.body : String(resolveGenerators(input.body));
        const output = await session.run(body);
        return { observation: output.observation, elapsedMs: output.elapsedMs };
      }
      case "values": {
        const context = this.buildContext(fixture, input);
        let text: string;
        try {
          text = session.serialize(context);
        } catch (error) {
          // The host-side ABI bounds (external data depth and size) refuse before the sandbox is entered.
          return { observation: serializationRefusal(error), elapsedMs: 0 };
        }
        const output = await session.run(text);
        return { observation: output.observation, elapsedMs: output.elapsedMs };
      }
    }
  }

  private buildContext(fixture: Fixture, input: Extract<VectorInput, { kind: "values" }>): Record<string, unknown> {
    const context: Record<string, unknown> = {
      formId: BASE_FORM_ID,
      values: resolveGenerators(input.values),
      locale: "locale" in input ? input.locale : "en",
      form: input.formPatch !== undefined ? input.formPatch(buildRoot(fixture)) : buildRoot(fixture)
    };
    if (input.externalData !== undefined) {
      context["externalData"] = resolveGenerators(input.externalData);
    }
    if (input.translations !== undefined) {
      context["translations"] = input.translations;
    }
    if (input.catalog !== undefined) {
      context["catalog"] = input.catalog;
    }
    if (input.kinds !== undefined) {
      context["kinds"] = input.kinds;
    }
    if (input.today !== undefined) {
      context["today"] = input.today;
    }
    if (input.hostContext !== undefined) {
      context["hostContext"] = input.hostContext;
    }
    if (input.document !== undefined) {
      context["document"] = input.document;
    }
    if (input.journey !== undefined) {
      context["journey"] = input.journey;
    }
    if (input.logLevel !== undefined) {
      context["logLevel"] = input.logLevel;
    }
    if (fixture.policy?.formulaErrors !== undefined) {
      context["formulaErrors"] = fixture.policy.formulaErrors;
    }
    if (fixture.policy?.riskyPatterns !== undefined) {
      context["riskyPatterns"] = fixture.policy.riskyPatterns;
    }
    if (fixture.policy?.unknownFields !== undefined) {
      context["unknownFields"] = fixture.policy.unknownFields;
    }
    if (fixture.snapshot !== undefined) {
      context["optionSnapshot"] = fixture.snapshot;
    }
    return context;
  }

  /**
   * Fills `$definition` (the fixture's definition text), `$detected`, `$floor`, `$nextMinor` and
   * `$baseTypes` in an inspect request written as JSON text. One pass: a token inside the
   * definition text is not substituted again.
   */
  private fillRequestText(template: string, fixture: Fixture): string {
    const detected = this.detection?.detected ?? this.config.abiFloor;
    const [major = "4", minor = "0"] = detected.split(".");
    const tokens: Record<string, () => string> = {
      definition: () => resolveDefinitionText(fixture),
      detected: () => detected,
      floor: () => this.config.abiFloor,
      nextMinor: () => `${major}.${Number(minor) + 1}.0`,
      nextMajor: () => `${Number(major) + 1}.0.0`,
      priorMajor: () => `${Number(major) - 1}.9.0`,
      baseTypes: () => JSON.stringify(baseTypes())
    };
    return template.replace(/\$(definition|detected|floor|nextMinor|nextMajor|priorMajor|baseTypes)\b/g, (_match, name: string) => (tokens[name] as () => string)());
  }

  /** Fills `$floor`, `$detected`, `$nextMinor`, `$nextMajor` and `$priorMajor` anywhere in an inspect request. */
  private substituteTokens(request: unknown): unknown {
    const detected = this.detection?.detected ?? this.config.abiFloor;
    const [major = "4", minor = "0"] = detected.split(".");
    const tokens: Record<string, string> = {
      $floor: this.config.abiFloor,
      $detected: detected,
      $nextMinor: `${major}.${Number(minor) + 1}.0`,
      $nextMajor: `${Number(major) + 1}.0.0`,
      $priorMajor: `${Number(major) - 1}.9.0`
    };
    const walk = (value: unknown): unknown => {
      if (typeof value === "string") {
        return tokens[value] ?? value;
      }
      if (Array.isArray(value)) {
        return value.map(walk);
      }
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));
      }
      return value;
    };
    return walk(request);
  }
}

/** An ABI serialization failure (external data too deep or too big) as the refusal it is. */
function serializationRefusal(error: unknown): Observation {
  const detail = error instanceof Error ? error.message : String(error);
  const refusal = /deeper|depth|nest|cycle/i.test(detail) ? "too_deep" : /more than|in all|too (?:large|big)|size/i.test(detail) ? "too_large" : "other";
  return { kind: "refusal", refusal, code: "serialize", detail };
}

function abiAtLeast(abi: string, floor: string): boolean {
  const left = abi.split(".").map(Number);
  const right = floor.split(".").map(Number);
  for (let at = 0; at < 3; at += 1) {
    const difference = (left[at] ?? 0) - (right[at] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return true;
}
