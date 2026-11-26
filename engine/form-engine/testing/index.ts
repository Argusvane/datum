/**
 * `@argusvane/datum-engine/testing` — fixtures and doubles the host packages' tests run against. A subpath
 * of its own, never re-exported from the root entry: nothing here belongs in a bundle.
 */
export { FIXTURE_FORM } from "./fixture-form.js";
// Kernel internals the host packages' tests exercise directly. They
// live here, not on the public entries, so no bundle picks them up (see the core/index.ts note on
// definition-structure.ts).
export { kernelStructureLimits } from "../core/expressions/definition-structure.js";
export { kernelFoldSubmission } from "../validation/wasm/portable-kernel.js";

// The WebMCP ModelContext double: registrar, binding and host-page tests
// run against Chrome 155's measured semantics without a browser.
export {
  createFakeModelContext,
  type FakeModelContext,
  type FakeModelContextCall,
  type FakeModelContextOptions,
  type ModelContextCarrier
} from "./fake-model-context.js";
