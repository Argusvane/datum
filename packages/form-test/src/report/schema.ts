/**
 * The JSON Schema (draft 2020-12) of the JSON report, for a CI step or
 * a dashboard that checks a report before it reads it. The objects this package owns say
 * `additionalProperties: false`, so a field added to `report/model.ts` without a row here fails
 * `tests/report.test.ts`; the engine's own step and scenario results stay open, because the
 * engine may add detail to a step without a new version of this tool.
 */

const count = { type: "integer", minimum: 0 } as const;

const summary = {
  type: "object",
  additionalProperties: false,
  required: ["scenarios", "passed", "failed", "skipped", "error", "parity", "problems"],
  properties: {
    scenarios: count,
    passed: count,
    failed: count,
    skipped: count,
    error: count,
    parity: count,
    problems: count
  }
} as const;

const sourceRef = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "id"],
      properties: { kind: { const: "definition" }, id: { type: "string" } }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "path"],
      properties: { kind: { const: "file" }, path: { type: "string" } }
    }
  ]
} as const;

const problem = {
  type: "object",
  additionalProperties: false,
  required: ["code", "line", "start", "end", "message"],
  properties: {
    code: { type: "string" },
    line: { type: "integer", minimum: 1 },
    start: count,
    end: count,
    params: { type: "object", additionalProperties: { type: ["string", "number"] } },
    message: { type: "string" }
  }
} as const;

const sourceReport = {
  type: "object",
  additionalProperties: false,
  required: ["source", "scenarioNames", "problems"],
  properties: {
    source: { $ref: "#/$defs/sourceRef" },
    scenarioNames: { type: "array", items: { type: "string" } },
    problems: { type: "array", items: { $ref: "#/$defs/problem" } }
  }
} as const;

const stepStatus = { enum: ["passed", "failed", "skipped", "error", "ran"] } as const;

const stepCell = {
  oneOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: { status: stepStatus, code: { type: "string" }, actual: {} }
    }
  ]
} as const;

const parityLine = {
  type: "object",
  additionalProperties: false,
  required: ["line", "runtime", "kernel"],
  properties: {
    line: { type: "integer", minimum: 1 },
    runtime: { $ref: "#/$defs/stepCell" },
    kernel: { $ref: "#/$defs/stepCell" }
  }
} as const;

const sideState = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { type: "string" }, reason: { type: "string" } }
} as const;

const parity = {
  type: "object",
  additionalProperties: false,
  required: ["status", "lines"],
  properties: {
    status: { enum: ["agree", "one-sided", "differ"] },
    lines: { type: "array", items: { $ref: "#/$defs/parityLine" } },
    scenario: {
      type: "object",
      additionalProperties: false,
      required: ["runtime", "kernel"],
      properties: { runtime: { $ref: "#/$defs/sideState" }, kernel: { $ref: "#/$defs/sideState" } }
    }
  }
} as const;

// The engine's FormTestScenarioResult and its steps: open, only what the renderers read is required.
const engineStep = {
  type: "object",
  required: ["line", "status"],
  properties: {
    line: { type: "integer", minimum: 1 },
    status: stepStatus,
    code: { type: "string" },
    params: { type: "object" }
  }
} as const;

const engineResult = {
  type: "object",
  required: ["name", "status", "steps"],
  properties: {
    name: { type: "string" },
    status: { enum: ["passed", "failed", "skipped", "error"] },
    reason: { type: "string" },
    params: { type: "object" },
    steps: { type: "array", items: { $ref: "#/$defs/engineStep" } }
  }
} as const;

const scenarioReport = {
  type: "object",
  additionalProperties: false,
  required: ["name", "source", "line", "status", "sides", "durationMs"],
  properties: {
    name: { type: "string" },
    source: { $ref: "#/$defs/sourceRef" },
    line: { type: "integer", minimum: 1 },
    status: { enum: ["passed", "failed", "skipped", "error", "parity"] },
    sides: {
      type: "object",
      additionalProperties: false,
      properties: { runtime: { $ref: "#/$defs/engineResult" }, kernel: { $ref: "#/$defs/engineResult" } }
    },
    parity: { $ref: "#/$defs/parity" },
    durationMs: { type: "number", minimum: 0 }
  }
} as const;

const coverageRule = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "ruleKey", "target", "formula", "sentence", "scenarios"],
  properties: {
    id: { type: "string" },
    kind: { type: "string" },
    ruleKey: { type: "string" },
    target: {
      type: "object",
      additionalProperties: false,
      required: ["id", "label", "type"],
      properties: { id: { type: "string" }, label: { type: "string" }, type: { type: "string" } }
    },
    formula: { type: "string" },
    sentence: { type: "string" },
    scenarios: { type: "array", items: { type: "string" } }
  }
} as const;

const coverage = {
  type: "object",
  additionalProperties: false,
  required: ["rules", "tested", "untested"],
  properties: {
    rules: { type: "array", items: { $ref: "#/$defs/coverageRule" } },
    tested: count,
    untested: count
  }
} as const;

const formReport = {
  type: "object",
  additionalProperties: false,
  required: ["path", "sources", "scenarios", "summary"],
  properties: {
    path: { type: "string" },
    title: { type: "string" },
    sources: { type: "array", items: { $ref: "#/$defs/sourceReport" } },
    scenarios: { type: "array", items: { $ref: "#/$defs/scenarioReport" } },
    coverage: { $ref: "#/$defs/coverage" },
    summary: { $ref: "#/$defs/summary" }
  }
} as const;

export const REPORT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://datum.dev/schemas/form-test-report.json",
  title: "datum-form-test report",
  type: "object",
  additionalProperties: false,
  required: ["tool", "startedAt", "durationMs", "runner", "program", "failOn", "forms", "summary", "verdict"],
  properties: {
    tool: {
      type: "object",
      additionalProperties: false,
      required: ["name", "version"],
      properties: { name: { const: "datum-form-test" }, version: { type: "string" } }
    },
    startedAt: { type: "string" },
    durationMs: { type: "number", minimum: 0 },
    runner: { enum: ["runtime", "kernel", "both"] },
    program: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["path", "bytes", "sha256"],
          properties: { path: { type: "string" }, bytes: count, sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } }
        }
      ]
    },
    failOn: { enum: ["failed", "untested"] },
    forms: { type: "array", items: { $ref: "#/$defs/formReport" } },
    summary: { $ref: "#/$defs/summary" },
    verdict: { enum: ["passed", "failed", "inconclusive"] }
  },
  $defs: {
    summary,
    sourceRef,
    problem,
    sourceReport,
    stepCell,
    parityLine,
    sideState,
    parity,
    engineStep,
    engineResult,
    scenarioReport,
    coverageRule,
    coverage,
    formReport
  }
} as const;
