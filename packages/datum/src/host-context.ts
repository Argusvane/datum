/**
 * The page's `hostContext` as `<datum-form>` keeps it. The sanitiser lives in the engine
 * (`core/state/host-context.ts`), where the builder's Try it Settings use it too; this module
 * keeps the element's import path.
 */
export { HOST_CONTEXT_MAX_DEPTH, HOST_CONTEXT_MAX_VALUES, plainHostContext } from "@argusvane/datum-engine";
export type { PlainHostContext } from "@argusvane/datum-engine";
