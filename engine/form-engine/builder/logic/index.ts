// The Logic model on its own subpath (`@argusvane/datum-engine/logic`): the rule list the Logic workspace
// shows, for a tool that reads a form's rules outside the builder (the form-test package's
// coverage). The builder's index also pulls in its custom elements, which a
// plain Node process must not load; logic-model.ts imports no DOM.
export { buildLogicModel } from "./logic-model.js";
export type { LogicModelOptions } from "./logic-model.js";
export type { LogicModel, LogicRule, LogicRuleKind, LogicToken } from "./logic-types.js";
export { COVERABLE_KINDS, coverageOf, coversRule, pathReaderOf } from "./coverage.js";
export type { CoverageOptions, CoverageReach, CoverageReport, CoverageRule, CoverageScenarioStatus, CoveredScenario, PathReader } from "./coverage.js";
