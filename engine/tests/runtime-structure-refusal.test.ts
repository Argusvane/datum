import { describe, expect, it } from "vitest";

import { EventBus } from "../form-engine/core/events/event-bus.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { FormStateStore } from "../form-engine/core/state/form-state.js";
import { kernelFoldEffective, kernelFoldInSection, kernelFoldVisibilityReadsHost } from "../form-engine/core/state/submittable-fold.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime, type FormRuntimeDependencies } from "../form-engine/runtime/browser/form-runtime.js";
import { RuntimeOrchestrator } from "../form-engine/runtime/browser/runtime-orchestrator.js";

function definitionOf(content: unknown[]): FormDefinition {
  return {
    id: "f",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    root: { id: "form", type: "form", configuration: {}, children: { content } }
  } as unknown as FormDefinition;
}

function construct(definition: FormDefinition): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, { submissionModes: modes } as unknown as FormRuntimeDependencies);
}

/** A component that holds a child with its own id: its parents, indexed by id, loop. */
const selfNested = [
  { id: "a", type: "container", configuration: {}, children: { default: [{ id: "a", type: "text", configuration: {} }] } }
];

describe("a form tree whose ids loop through their parents", () => {
  it("is refused when the runtime is built, at once and naming where", () => {
    const started = Date.now();
    expect(() => construct(definitionOf(selfNested))).toThrow(/root > content > a > default > a|root > content > a/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("is refused when a slot holds something that is no component", () => {
    expect(() => construct(definitionOf([null]))).toThrow(/root > content/);
  });

  it("still builds a form whose siblings share an id", () => {
    const runtime = construct(
      definitionOf([
        { id: "x", type: "text", configuration: {} },
        { id: "x", type: "text", configuration: {} }
      ])
    );
    runtime.setValue("x", "one");
    expect(runtime.state().values.x).toBe("one");
  });

  it("never records a parent that closes a loop when an orchestrator is given such a tree", () => {
    const root = definitionOf(selfNested).root as ComponentNode;
    const started = Date.now();
    const orchestrator = new RuntimeOrchestrator(new ComponentTree(root), { eventBus: new EventBus(), formId: "f" });
    const store = new FormStateStore("en");
    orchestrator.recompute(store.snapshot());
    expect(orchestrator.effectiveStateFor("a")).toBeDefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("the fold's walks up the parents", () => {
  const looping: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, { a: "b", b: "a" });
  const nodes = Object.assign(Object.create(null) as Record<string, ComponentNode>, {
    a: { id: "a", type: "container", configuration: {} },
    b: { id: "b", type: "container", configuration: {} }
  }) as Record<string, ComponentNode>;

  it("end on a parent map that loops", () => {
    expect(kernelFoldInSection("a", nodes, looping)).toBe(false);
    expect(kernelFoldVisibilityReadsHost("a", nodes, looping)).toBe(false);
    const own = { visible: true, enabled: true, readonly: false, required: false };
    const effective = kernelFoldEffective(["a", "b"], looping, { a: own, b: own } as never);
    expect(Object.keys(effective)).toEqual(["a", "b"]);
  });
});
