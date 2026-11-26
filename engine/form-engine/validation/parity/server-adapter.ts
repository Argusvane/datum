import type { ValidationContext } from "../../core/schema/contracts.js";
import type { ServerValidationRunner } from "../server/server-validation.js";
import type { DeterministicRuntimeAdapter } from "./runtime-adapter.js";

/**
 * Wraps the deterministic subset of a {@link ServerValidationRunner} as a parity adapter.
 * Only deterministic server hooks should participate in parity checks.
 */
export function createServerAdapter(
  runner: ServerValidationRunner,
  servicesProvider?: () => Record<string, unknown>
): DeterministicRuntimeAdapter {
  return {
    id: "server",
    run: (context: ValidationContext) =>
      runner.run({
        values: context.values,
        formId: context.formId,
        validationContext: context,
        services: servicesProvider ? servicesProvider() : {},
        environment: "server"
      })
  };
}
