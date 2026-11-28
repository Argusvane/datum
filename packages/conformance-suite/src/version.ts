export const SUITE_NAME = "@argusvane/datum-conformance-suite";
export const SUITE_VERSION = "0.1.0";
/** Changes whenever a vector is added, removed or its expectation changes; printed in every report. */
export const VECTOR_SET_ID = "2026.11.15-2";
/**
 * The sandbox ABI the suite holds a program to: the golden file's major, at its first version.
 * `--abi-floor` may raise it within the same major, never lower it.
 */
export const DEFAULT_ABI_FLOOR = "1.0.0";
