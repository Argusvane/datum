/**
 * The shared answers module: field kinds, options,
 * writability and the reading of an answer, shared by the renderer catalogue (`agent/form/`,
 * which words every problem into its renderer's refusal) and the builder's Try it tool (which
 * words them in its own catalogue). Hint-free and tool-name-free, and it imports nothing from
 * `agent/form/` or `agent/builder/`, so the builder bundle can carry it without the renderer
 * catalogue (guard 15). Not exported from the agent barrel; the two catalogues import it by
 * relative path.
 */

export { coerceAnswer, coerceRowsAnswer, STRING_VALUE_CAP, type CoerceOptions, type RowsCoerceOptions } from "./coerce.js";
export {
  DESCRIPTION_CAP,
  LABEL_CAP,
  isCalculated,
  isNestedCollection,
  kindOf,
  kindOfNode,
  optionsOf,
  unfillableStaticKind,
  type FieldColumn,
  type FieldKind,
  type Option
} from "./kinds.js";
export { OPTIONS_IN_PROBLEM, matchOption, normalizeLabel, type MatchOptions } from "./match.js";
export { echoValue, invalidValueProblem, type AnswerProblem, type AnswerProblemCode, type AnswerResult } from "./problems.js";
export {
  writabilityOf,
  writabilityOfState,
  type UnfillableKind,
  type WhyNotWritable,
  type Writability,
  type WritabilityPlace,
  type WritableState
} from "./writability.js";
