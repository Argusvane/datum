export { openParityAdapters, type ParityAdapters } from "./adapters.js";
export { compareBytes, type ByteComparison } from "./compare.js";
export { contextFor } from "./context.js";
export { digestParity, programDigestOf, submissionDigestOf, type DigestRow, type DigestSource } from "./digest.js";
export { DIVERGENCES, settleAgainstLedger, type Divergence, type LedgerOutcome, type ParityPair } from "./divergences.js";
export { FUNCTION_CASES, FUNCTION_TODAY, type FunctionCase, type FunctionResultKind } from "./functions.js";
export { pluginFunctionParity, type PluginFunctionParityOptions } from "./plugin-functions.js";
export { corpusRows, runParityVectors, type CorpusRow, type ParityRunOptions, type ParityRunOutput } from "./parity-runner.js";
