import { describe, expect, it } from "vitest";

import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import { ComponentRegistry } from "../form-engine/registry/components/component-registry.js";

function def(type: string, version: string): ComponentDefinition {
  return {
    type,
    version,
    createDefault: () => ({ id: `${type}_${version}`, type, configuration: {} }),
    capabilities: []
  };
}

describe("component registry", () => {
  it("resolves latest version by default", () => {
    const registry = new ComponentRegistry();
    registry.register(def("text", "1.0.0"));
    registry.register(def("text", "1.2.0"));

    expect(registry.resolve("text").version).toBe("1.2.0");
  });

  it("resolves exact requested version", () => {
    const registry = new ComponentRegistry();
    registry.register(def("text", "1.0.0"));
    registry.register(def("text", "2.0.0"));

    expect(registry.resolve("text", "1.0.0").version).toBe("1.0.0");
  });

  it("rejects duplicate version registration", () => {
    const registry = new ComponentRegistry();
    registry.register(def("text", "1.0.0"));

    expect(() => registry.register(def("text", "1.0.0"))).toThrow(
      /already registered/
    );
  });

  it("lists the latest definition of every type, in first-registered order", () => {
    const registry = new ComponentRegistry();
    registry.register(def("text", "1.2.0"));
    registry.register(def("rating", "1.0.0"));
    registry.register(def("text", "1.0.0"));

    expect(registry.latest().map((entry) => `${entry.type}@${entry.version}`)).toEqual(["text@1.2.0", "rating@1.0.0"]);
  });
});
