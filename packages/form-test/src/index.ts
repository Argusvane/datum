/**
 * `@argusvane/datum-form-test`'s programmatic surface: the command as a function,
 * the run, the two sides, parity, coverage, the renderers, the words and the loaders. Never
 * imports `vitest`: the helper is its own entry (`@argusvane/datum-form-test/vitest`, `dist/vitest.mjs`),
 * which reaches everything it needs through this module, so the bundle carries the engine once.
 */
export { runCli } from "./cli.js";
export type { CliIo } from "./cli.js";
export { parseArgs, UsageError, USAGE } from "./args.js";
export type { CliOptions, ReportFormat } from "./args.js";
export { EXIT } from "./exit-codes.js";
export type { ExitCode } from "./exit-codes.js";
export { TOOL_NAME, TOOL_VERSION } from "./version.js";

export { exitCodeOf, runFormTests, runScenarioOnSides, sidesOf, summarize, verdictOf } from "./run.js";
export type { HostedEnvironment } from "./run.js";
export { createSideHost, disposeSideHost, makeKernelDriver, makeRuntime, makeRuntimeDriver, runtimeFactoryOf } from "./drivers.js";
export { compareSides, scenarioStatusOf } from "./parity.js";
export { coverageOf } from "./coverage.js";

export { renderJson } from "./report/json.js";
export { renderJunit } from "./report/junit.js";
export { renderMarkdown } from "./report/markdown.js";
export { REPORT_SCHEMA } from "./report/schema.js";
export * from "./report/words.js";

export { InputError, loadDefinitionFile, loadProgramFile, loadTestFile, sidecarPathOf, titleOf } from "./load.js";

// What the vitest helper reads from the engine, re-exported so `dist/vitest.mjs` takes it from
// `dist/index.mjs` instead of bundling a second copy of the parser (scripts/bundle-options.mjs).
export { formulaFunctionSignatures } from "@argusvane/datum-engine/core";
export { kernelParseFormTests, readFormTests } from "@argusvane/datum-engine/form-tests";

export type * from "./api.js";
export type * from "./report/model.js";
