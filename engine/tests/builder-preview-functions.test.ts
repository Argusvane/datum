import { describe, expect, it } from "vitest";

import { BuilderPreviewRuntime } from "../form-engine/builder/preview/builder-preview-runtime.js";
import { formulaSignatures } from "../form-engine/builder/formula/feel-functions.js";
import { FormulaFunctionRegistry } from "../form-engine/registry/formula-functions/formula-function-registry.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";

/** A form whose fee is worked out by a plugin function: the rule as text, as the tree stores it. */
function fundForm(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "employees", type: "number", configuration: { label: "Employees" } },
        { id: "fee", type: "number", configuration: { label: "Fee" }, rules: { value: "double(employees)" } }
      ]
    }
  } as unknown as ComponentNode;
}

function doubleRegistry(): FormulaFunctionRegistry {
  const registry = new FormulaFunctionRegistry();
  registry.register(
    { name: "double", params: ["n"], summary: "Twice a number.", example: "double(2)", returns: "number", evaluate: (args) => Number(args[0]) * 2 },
    "double-plugin"
  );
  return registry;
}

describe("BuilderPreviewRuntime and plugin formula functions", () => {
  it("works a rule calling a plugin function out with the registry's functions and signatures", () => {
    const registry = doubleRegistry();
    const preview = new BuilderPreviewRuntime(fundForm(), { functions: registry.functions(), signatures: formulaSignatures(registry) });
    preview.setValue("employees", 21);
    expect(preview.state().values.fee).toBe(42);
  });

  it("gives nothing for the call without the functions, as the form without the plugin would", () => {
    const preview = new BuilderPreviewRuntime(fundForm());
    preview.setValue("employees", 21);
    expect(preview.state().values.fee).toBeUndefined();
  });

  it("takes functions wired after it was built, keeping the values the author typed", () => {
    const preview = new BuilderPreviewRuntime(fundForm());
    preview.setValue("employees", 21);
    expect(preview.state().values.fee).toBeUndefined();
    const registry = doubleRegistry();
    let initialized = 0;
    preview.events().subscribe(FormEventType.FORM_INITIALIZED, () => {
      initialized += 1;
    });
    preview.setFunctions(registry.functions(), formulaSignatures(registry));
    expect(preview.state().values.employees).toBe(21);
    expect(preview.state().values.fee).toBe(42);
    expect(initialized).toBe(1);
    // The same functions again: nothing to rebuild.
    const functions = registry.functions();
    preview.setFunctions(functions);
    preview.setFunctions(functions);
    expect(initialized).toBe(2);
  });
});

describe("BuilderPreviewRuntime and the tree it is given (Try it shares siblings)", () => {
  const deepFreeze = <T>(value: T): T => {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const inner of Object.values(value as Record<string, unknown>)) {
        deepFreeze(inner);
      }
    }
    return value;
  };

  it("never writes into the tree it is given: a deeply frozen tree builds, takes answers and works a rule out", () => {
    const registry = doubleRegistry();
    const root = deepFreeze(fundForm());
    const preview = new BuilderPreviewRuntime(root, { functions: registry.functions(), signatures: formulaSignatures(registry) });
    preview.setValue("employees", 21);
    expect(preview.state().values.fee).toBe(42);
    preview.effectiveStatesMap();
    preview.requiredMap();
    preview.setFormRoot(deepFreeze(fundForm()));
    expect(preview.state().values.fee).toBe(42);
  });
});
