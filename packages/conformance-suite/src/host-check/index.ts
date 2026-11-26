// The host conformance kit's API (the command is main.ts). Imported by the tests and by a caller
// that wants to run the cases from its own script.
export { runHostCheckCli, HOST_EXIT, type HostCliIo, type HostCliHooks } from "./cli.js";
export { compareAgentCatalogues, compareAgentDocs, compareToolDump, type AgentToolsFinding, type AgentToolsFindingKind, type AgentToolsGolden, type GoldenTool } from "./agent-tools/compare.js";
export { parseHostArgs, HostUsageError, HOST_USAGE, type HostCheckArgs } from "./args.js";
export { CAPABILITY_ORDER, CAPABILITY_NOTES, capabilityOf, capabilitiesOf, type Capability } from "./capabilities.js";
export { CASES, MODULES, caseById, moduleOf } from "./cases/index.js";
export { hostCase, titleOf, contextFor, type HostCase, type CaseContext, type CapabilityModule, type Probe, type ProbeContext, type ProbeOutcome } from "./case.js";
export { HostHttp, Reply, CookieJar, TransportError, wireProblems, splitUrl, TYPED_503_CODES, type Exchange, type SendOptions, type RawRequest, type RawResponse } from "./http.js";
export { CaseFailure, CaseSkipped, check, assume, expectStatus, expectCode, expectHeader, expectJson, expectJsonEqual, expectEqual, expectMatches, expectContains, expectNotContains, expectSet, textAt } from "./expect.js";
export * as hostFixtures from "./fixtures.js";
export { REACHABLE, CSRF_TOKEN, FIXTURE_FORM, SUBMIT_ROUTE, VALIDATE_ROUTE, DRY_RUN_SWITCH, DEFINITION_ROUTE, ASSETS_ROUTE } from "./preflight.js";
export { runHostCheck, selectCases, decide, SelectionError, type RunOutcome, type CaseResult, type CaseStatus, type HostVerdict, type Selection } from "./runner.js";
export { buildReport, renderReportJson, renderReportMarkdown, redactArgv, type HostCheckReport } from "./report.js";
export { targetFrom, parseProperties, csrfOf, api, PREFIX, DEFAULT_TIMEOUT_MS, TargetError, type HostTarget, type Who, type CsrfRecipe } from "./target.js";
export { KIT_NAME, KIT_VERSION, CASE_SET_ID } from "./version.js";
