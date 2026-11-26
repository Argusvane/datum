import { describe, expect, it } from "vitest";

import type { FormDefinition, ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormEvent } from "../form-engine/core/events/event-bus.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";

function form(): FormDefinition {
  const root: ComponentNode = {
    id: "root",
    type: "container",
    configuration: {},
    children: {
      children: [
        { id: "firstName", type: "text", configuration: {} },
        {
          id: "address",
          type: "container",
          configuration: { nested: true },
          children: { children: [{ id: "city", type: "text", configuration: {} }] }
        }
      ]
    }
  };
  return { id: "f1", version: "1", schemaVersion: "1", root, localization: { defaultLocale: "en-CA" } };
}

function runtimeWithLog(): { runtime: FormRuntime; seen: FormEvent[] } {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "validate", validate: true, sign: false, serverValidation: false });
  const runtime = new FormRuntime(form(), { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
  const seen: FormEvent[] = [];
  runtime.events().subscribe("*", (event) => seen.push(event));
  return { runtime, seen };
}

// A keystroke is an interim write; leaving the control commits it.
describe("form runtime: interim writes and commits", () => {
  it("publishes the payload it always did for a final write, and flags an interim one", () => {
    const { runtime, seen } = runtimeWithLog();

    runtime.setValue("firstName", "Ada");
    runtime.setValue("firstName", "Ada L", { interim: true });
    runtime.setValue("firstName", "Ada Lovelace", { interim: false });

    const changes = seen.filter((event) => event.type === FormEventType.COMPONENT_CHANGED);
    expect(changes.map((event) => event.data)).toEqual([
      { value: "Ada" },
      { value: "Ada L", interim: true },
      { value: "Ada Lovelace" }
    ]);
    // The store and the recompute see every write, interim or not.
    expect(runtime.state().values.firstName).toBe("Ada Lovelace");
    expect(seen.filter((event) => event.type === FormEventType.RECOMPUTE_COMPLETED).length).toBe(3);
  });

  it("commits with the stored value, writing and recomputing nothing", () => {
    const { runtime, seen } = runtimeWithLog();
    runtime.setValue("firstName", "Ada", { interim: true });
    seen.length = 0;

    runtime.commitValue("firstName");

    expect(seen.map((event) => event.type)).toEqual([FormEventType.COMPONENT_COMMITTED]);
    expect(seen[0]!.data).toEqual({ value: "Ada" });
    expect(seen[0]!.path?.segments.map((segment) => segment.key)).toEqual(["firstName"]);
    expect(seen[0]!.source).toBe("runtime");
  });

  it("commits a nested value path as it was written", () => {
    const { runtime, seen } = runtimeWithLog();
    runtime.setValue("address.city", "Halifax", { interim: true });
    seen.length = 0;

    runtime.commitValue("address.city");

    expect(seen.length).toBe(1);
    expect(seen[0]!.data).toEqual({ value: "Halifax" });
    expect(seen[0]!.path?.segments.map((segment) => segment.key)).toEqual(["address", "city"]);
  });
});
