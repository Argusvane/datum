import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseArgs, UsageError, USAGE, type CliOptions } from "./args.js";
import { EXIT, type ExitCode } from "./exit-codes.js";
import type { GoldenFile } from "./fixtures/golden.js";
import { CUSTOM_PREDICATES } from "./customs.js";
import { describe as describeExpectation } from "./predicates.js";
import { renderJson } from "./report/json.js";
import { renderMarkdown } from "./report/markdown.js";
import { loadProgram, ProgramLoadError, type LoadedProgram } from "./runners/program/load-program.js";
import { readManifestAbi, runSuite } from "./run.js";
import { loadPdfProgramFile, PdfProgramLoadError, runPdfVectors, withPdf } from "./runners/pdf/index.js";
import type { Report } from "./report/model.js";
import { endpointConfigFrom } from "./runners/endpoint/config.js";
import { endpointRowLines, runEndpoint, runsOnEndpoint } from "./runners/endpoint/endpoint-runner.js";
import { fixtureDefinition, submissionsFixture } from "./runners/endpoint/fixture.js";
import { withEndpoint } from "./runners/endpoint/report.js";
import { builderConfigFrom } from "./runners/endpoint/profiles/builder-config.js";
import { builderPlan, runBuilder, runBuilderCleanup } from "./runners/endpoint/profiles/builder-lifecycle.js";
import { withBuilder } from "./runners/endpoint/profiles/builder-report.js";
import { builderRowLines, runsOnBuilder } from "./runners/endpoint/profiles/builder-specs.js";
import { SUITE_NAME, SUITE_VERSION, VECTOR_SET_ID } from "./version.js";
import { knownSelector, VECTORS, vectorById } from "./vectors/index.js";
import type { PluginSource, Vector } from "./vectors/schema.js";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface CliHooks {
  /**
   * A program built from the repository's source (the checkout script supplies it; the bundled CLI
   * never builds one). Used when `--program` is not given.
   */
  builtProgram?: () => LoadedProgram;
}

const processIo: CliIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text)
};

/** The whole command line, as a function: arguments in, an exit code out. Never throws. */
export async function runCli(argv: readonly string[], io: CliIo = processIo, hooks: CliHooks = {}): Promise<ExitCode> {
  try {
    return await dispatch(argv, io, hooks);
  } catch (error) {
    if (error instanceof UsageError || error instanceof ProgramLoadError || error instanceof PdfProgramLoadError) {
      io.stderr(`datum-security-check: ${error.message}\n`);
      return EXIT.usage;
    }
    io.stderr(`datum-security-check: internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return EXIT.internal;
  }
}

async function dispatch(argv: readonly string[], io: CliIo, hooks: CliHooks): Promise<ExitCode> {
  const options = parseArgs(argv);
  switch (options.command) {
    case "help":
      io.stdout(USAGE);
      return EXIT.pass;
    case "version":
      io.stdout(`${SUITE_NAME} ${SUITE_VERSION} (vector set ${VECTOR_SET_ID})\n`);
      return EXIT.pass;
    case "list":
      return list(options, io);
    case "explain":
      return explain(options, io);
    case "fixture":
      return fixture(options, io);
    case "builder-cleanup":
      return builderCleanup(options, io);
    case "run":
      return run(options, io, hooks);
  }
}

function list(options: CliOptions, io: CliIo): ExitCode {
  if (options.json) {
    io.stdout(
      `${JSON.stringify(
        {
          suite: { name: SUITE_NAME, version: SUITE_VERSION, vectorSet: VECTOR_SET_ID, vectorCount: VECTORS.length },
          vectors: VECTORS.map((vector) => ({
            id: vector.id,
            title: vector.title,
            class: vector.class,
            severity: vector.severity,
            attacker: vector.attacker,
            gate: vector.gate,
            expected: describeExpectation(vector.expect, CUSTOM_PREDICATES),
            provenance: vector.provenance,
            applies: { program: vector.applies.program !== false, endpoint: runsOnEndpoint(vector), builder: runsOnBuilder(vector), parity: vector.applies.parity !== false }
          }))
        },
        null,
        2
      )}\n`
    );
    return EXIT.pass;
  }
  const lines = ["ID       Sev  Gate      Class      Title"];
  for (const vector of VECTORS) {
    const gate = vector.gate.status === "pending" ? `pending(${vector.gate.blockedBy})` : vector.gate.status;
    lines.push(`${vector.id.padEnd(8)} ${vector.severity.padEnd(4)} ${gate.padEnd(9)} ${vector.class.padEnd(10)} ${vector.title}`);
  }
  io.stdout(`${lines.join("\n")}\n`);
  return EXIT.pass;
}

function explain(options: CliOptions, io: CliIo): ExitCode {
  const vector = vectorById((options.target ?? "").toUpperCase());
  if (vector === undefined) {
    throw new UsageError(`no vector ${options.target}; "list" shows them`);
  }
  io.stdout(`${explainText(vector)}\n`);
  return EXIT.pass;
}

function explainText(vector: Vector): string {
  const lines = [
    `${vector.id}  ${vector.title}`,
    `  class ${vector.class} | severity ${vector.severity} | attacker ${vector.attacker}`,
    `  gate ${vector.gate.status === "pending" ? `pending, blocked by ${vector.gate.blockedBy}` : vector.gate.status}`,
    `  expects: ${vector.predicate ?? describeExpectation(vector.expect, CUSTOM_PREDICATES)}`,
    `  runs on: ${(["program", "endpoint", "builder", "parity"] as const).filter((runner) => (runner === "endpoint" ? runsOnEndpoint(vector) : runner === "builder" ? runsOnBuilder(vector) : vector.applies[runner] !== false)).map(String).concat(vector.class === "output" ? ["pdf"] : []).join(", ") || "nothing yet"}`
  ];
  if (vector.hostSensitive === true) {
    lines.push("  note: says nothing about a wasmtime host (the emscripten QuickJS has these absent by construction)");
  }
  for (const variant of vector.variants ?? []) {
    lines.push(`  variant ${variant.id}${variant.expect !== undefined ? `: ${describeExpectation(variant.expect, CUSTOM_PREDICATES)}` : ""}`);
  }
  lines.push(...endpointRowLines(vector));
  lines.push(...builderRowLines(vector, (expectation) => describeExpectation(expectation, CUSTOM_PREDICATES)));
  for (const test of vector.provenance.tests) {
    lines.push(`  test: ${test.path}${test.name !== undefined ? ` (${test.name})` : ""}`);
  }
  if (vector.provenance.tests.length === 0) {
    lines.push("  test: none");
  }
  return lines.join("\n");
}

/** `--form-version` is "1" unless given; the fixture file already says "1", so only a different value rewrites it. */
function fixtureVersionOf(options: CliOptions): string | undefined {
  return options.formVersion !== "1" ? options.formVersion : undefined;
}

function fixture(options: CliOptions, io: CliIo): ExitCode {
  if (options.fixtureFormat === "submissions") {
    io.stdout(`${JSON.stringify(submissionsFixture(options.form, fixtureVersionOf(options)), null, 2)}\n`);
    return EXIT.pass;
  }
  io.stdout(`${JSON.stringify(fixtureDefinition(options.form, fixtureVersionOf(options)), null, 2)}\n`);
  return EXIT.pass;
}

async function run(options: CliOptions, io: CliIo, hooks: CliHooks): Promise<ExitCode> {
  const runStarted = performance.now();
  const runStartedAt = new Date();
  if (!options.builder && options.builderFlags.length > 0) {
    throw new UsageError(`${options.builderFlags[0]} needs --builder`);
  }
  const builderConfig = options.builder ? builderConfigFrom(options) : undefined;
  if (builderConfig?.dryRun === true) {
    io.stdout(`${builderPlan(builderConfig).join("\n")}\n`);
    return EXIT.pass;
  }
  // With --builder, the receiving-endpoint run happens only when a form is named (--form): the builder makes its own.
  const endpointConfig = (options.endpoint !== undefined || options.endpointFlags.length > 0) && !(options.builder && options.form === undefined) ? endpointConfigFrom(options) : undefined;
  const remote = endpointConfig !== undefined || builderConfig !== undefined || options.pdf;
  for (const selector of [...options.only, ...options.skip]) {
    if (!knownSelector(selector)) {
      throw new UsageError(`"${selector}" is not a vector id or class; "list" shows them`);
    }
  }
  let program: LoadedProgram | undefined;
  if (options.program !== undefined) {
    program = loadProgram(options.program);
  } else if (hooks.builtProgram !== undefined && (!remote || options.parity || options.all)) {
    program = hooks.builtProgram();
  } else if (!remote) {
    throw new UsageError("give --program <file> (a datum-sandbox-program.js), --endpoint <url>, or run `list`, `explain <id>` or `fixture`");
  } else if (options.parity || options.all) {
    throw new UsageError("--parity and --all compare against a program: give --program <file> as well");
  }
  const manifestAbi = options.manifest !== undefined ? manifestAbiOf(options.manifest) : undefined;
  const golden = options.golden !== undefined ? goldenFrom(options.golden) : undefined;
  const plugins = options.plugins.map(pluginFrom);

  let report: Report | undefined = program === undefined ? undefined : await runSuite({
    program,
    abiFloor: options.abiFloor,
    budgetProfile: options.budgetProfile,
    ...(manifestAbi !== undefined ? { manifestAbi } : {}),
    ...(golden !== undefined ? { golden } : {}),
    plugins,
    only: options.only,
    skip: options.skip,
    gate: options.gate,
    failOn: options.failOn,
    heavy: options.heavy,
    modes: options.all ? ["program", "parity"] : options.parity ? ["parity"] : ["program"],
    argv: options.argv
  });
  if (endpointConfig !== undefined) {
    const endpointRun = await runEndpoint(endpointConfig);
    report = withEndpoint(report, endpointRun, { failOn: options.failOn, gate: options.gate, argv: options.argv, startedAt: runStartedAt, startedMs: runStarted });
  }
  if (builderConfig !== undefined) {
    // The plan is printed first (to stderr, so a JSON report on stdout stays clean): what will be created, sent and removed.
    if (!options.quiet) {
      io.stderr(`${builderPlan(builderConfig, undefined).slice(0, 5).join("\n")}\n`);
    }
    // SIGINT and SIGTERM stop the run after the request in flight; the cleanup still runs.
    const controller = new AbortController();
    const onSignal = (): void => controller.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      const builderRun = await runBuilder({ ...builderConfig, signal: controller.signal });
      report = withBuilder(report, builderRun, { failOn: options.failOn, gate: options.gate, argv: options.argv, startedAt: runStartedAt, startedMs: runStarted });
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
  if (options.pdf) {
    // The PDF output vectors (OUT): the PDF program renders hostile answers and the output bytes are inspected.
    const pdfProgram = loadPdfProgramFile(options.pdfProgram);
    const pdfRun = await runPdfVectors({ program: pdfProgram, catalogue: VECTORS, gate: options.gate, only: options.only, skip: options.skip });
    report = withPdf(report, pdfRun, { failOn: options.failOn, gate: options.gate, argv: options.argv, startedAt: runStartedAt, startedMs: runStarted });
  }
  if (report === undefined) {
    throw new UsageError("nothing to run");
  }

  emit(options, report, io);
  switch (report.verdict) {
    case "PASS":
      return EXIT.pass;
    case "FAIL":
      return EXIT.fail;
    case "INCONCLUSIVE":
      return EXIT.inconclusive;
  }
}

async function builderCleanup(options: CliOptions, io: CliIo): Promise<ExitCode> {
  const config = builderConfigFrom({ ...options, allowWrites: true });
  const { ok, message } = await runBuilderCleanup(config);
  (ok ? io.stdout : io.stderr)(`${message}\n`);
  return ok ? EXIT.pass : EXIT.inconclusive;
}

function emit(options: CliOptions, report: Awaited<ReturnType<typeof runSuite>>, io: CliIo): void {
  const json = renderJson(report);
  const markdown = renderMarkdown(report);
  if (options.out === undefined) {
    if (!options.quiet) {
      io.stdout(options.formats.includes("md") ? markdown : json);
    }
    return;
  }
  if (options.out === "-") {
    io.stdout(options.formats.includes("json") ? json : markdown);
    return;
  }
  const dir = resolve(options.out);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  if (options.formats.includes("json")) {
    writeFileSync(join(dir, "report.json"), json);
    written.push(join(dir, "report.json"));
  }
  if (options.formats.includes("md")) {
    writeFileSync(join(dir, "report.md"), markdown);
    written.push(join(dir, "report.md"));
  }
  if (!options.quiet) {
    const s = report.summary;
    io.stdout(`${report.verdict}: ${s.pass} pass, ${s.fail} fail, ${s.warn} warn, ${s.skip} skip, ${s.xfail} xfail, ${s.xpass} xpass, ${s.error} error\n${written.map((path) => `wrote ${path}`).join("\n")}\n`);
  }
}

function manifestAbiOf(path: string): string {
  try {
    return readManifestAbi(path);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function goldenFrom(path: string): GoldenFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(`cannot read the golden file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const file = parsed as Partial<GoldenFile> | null;
  if (file === null || typeof file !== "object" || typeof file.abi !== "string" || file.controls === undefined || !Array.isArray(file.documents)) {
    throw new UsageError(`the golden file ${path} is not a golden file (it needs abi, goldenCase, documents and controls)`);
  }
  return file as GoldenFile;
}

/** A plugin module file: its text is the module's source (an expression that evaluates to `{ validators, functions }`). */
function pluginFrom(path: string): PluginSource {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new UsageError(`cannot read the plugin module ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { id: path, version: "0.0.0", source };
}
