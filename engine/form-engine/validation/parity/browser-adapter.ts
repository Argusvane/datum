import type { ValidationContext } from "../../core/schema/contracts.js";
import type { ValidationPipeline } from "../core/validation-pipeline.js";
import type { DeterministicRuntimeAdapter } from "./runtime-adapter.js";

/** Wraps a {@link ValidationPipeline}'s deterministic stages as a parity adapter. */
export function createBrowserAdapter(pipeline: ValidationPipeline): DeterministicRuntimeAdapter {
  return {
    id: "browser",
    run: (context: ValidationContext) => pipeline.runDeterministic(context).merged
  };
}
