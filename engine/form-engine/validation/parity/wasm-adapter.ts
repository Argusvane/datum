import type { ValidationContext } from "../../core/schema/contracts.js";
import type { FieldConstraintsContext } from "../core/field-constraints.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { WasmValidationHost } from "../wasm/wasm-validation-host.js";
import type { DeterministicRuntimeAdapter } from "./runtime-adapter.js";

/**
 * Wraps a {@link WasmValidationHost} (running under STRICT policy) as a parity adapter.
 * The ABI context carries the schema, so the adapter needs the form root the vectors were
 * written against; the outcome's error contract is what parity compares.
 */
export function createWasmAdapter(
  host: WasmValidationHost,
  root: ComponentNode
): DeterministicRuntimeAdapter {
  return {
    id: "wasm",
    run: async (context: ValidationContext) => {
      // The browser's `requiredComponents`, `invalidComponents` and
      // `inputStates` never cross the ABI: the kernel works requiredness and its
      // checks out for itself, and a control's state is the browser's alone. A spread would
      // carry them — TypeScript checks no excess property on a spread — so they are taken out
      // by name.
      const {
        requiredComponents: _requiredComponents,
        invalidComponents: _invalidComponents,
        inputStates: _inputStates,
        translations,
        ...crossing
      } = context as FieldConstraintsContext;
      const outcome = await host.run({
        // The definition's translations cross only when the runtime set them.
        context: { ...crossing, form: root, ...(translations !== undefined ? { translations } : {}) },
        policy: WasmValidationHost.STRICT_POLICY
      });
      return { errors: outcome.errors };
    }
  };
}
